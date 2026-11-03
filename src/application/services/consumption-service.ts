import pool from '../../infrastructure/database/pool.ts';
import type { PoolClient } from 'pg';
import { MerchantKybService } from './merchant-kyb-service.ts';
import { FinancialOperationService } from './financial-operation-service.ts';
import { resolvePointsOwner, consumeReservedPoints } from './pay/points-wallet-service.ts';
import { reservePoints, lockPointsOwner } from './pay/points-reservation-service.ts';
import { recordMerchantPointsConsumption } from './pay/points-benefits-service.ts';

export interface ConsumeKCommand {
  idempotencyKey: string;
  userId: string;
  merchantProfileId: string;
  amount: number;
  currency: string;
  quantityK: number;
  /** Proof hash of the official valuation that produced quantityK, when the payment has one. */
  quantityValuationProofHash?: string;
  merchantSaleRef: string;
  qrCodeName?: string;
  rail: string;
  /** Payment country already resolved by PaymentContext; null when no PaymentContext applies (e.g. API checkout Points K). */
  paymentCountry: string | null;
  klotId?: string;
  klotQuantity?: number;
}

export interface ConsumptionResult {
  success: boolean;
  financialTransactionId?: string;
  merchantSaleId?: string;
  intercompanyPositionId?: string;
  error?: string;
}

async function getMerchantInfo(client: import('pg').PoolClient, merchantProfileId: string) {
  const { rows } = await client.query(
    `SELECT mp.country
     FROM konektag.merchant_profiles mp
     WHERE mp.id = $1 AND mp.deleted_at IS NULL`,
    [merchantProfileId],
  );
  if (!rows[0]) throw new Error('Merchant not found');
  return rows[0];
}

async function getUserInfo(client: import('pg').PoolClient, userId: string): Promise<{ country: string; keycloakId: string }> {
  const { rows } = await client.query(
    `SELECT country, keycloak_id FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!rows[0]) throw new Error('User not found');
  return { country: rows[0].country, keycloakId: rows[0].keycloak_id };
}

async function getRegulatoryProfile(client: import('pg').PoolClient, operation: string, origin: string, destination: string): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT id FROM konektag.regulatory_profiles
     WHERE authorized_operation = $1 AND country_of_origin = $2 AND country_of_destination = $3
       AND status = 'APPROVED' AND deleted_at IS NULL
     LIMIT 1`,
    [operation, origin, destination],
  );
  return rows[0]?.id || null;
}

export const consumptionService = {
  async consumeAtMerchant(cmd: ConsumeKCommand, transactionClient?: PoolClient): Promise<ConsumptionResult> {
    const client = transactionClient ?? await pool.connect();
    const ownsTransaction = !transactionClient;
    try {
      if (ownsTransaction) await client.query('BEGIN');

      if(!Number.isSafeInteger(cmd.quantityK) || cmd.quantityK<=0) throw new Error('INVALID_POINTS_QUANTITY');
      if(!Number.isSafeInteger(cmd.amount) || cmd.amount<=0) throw new Error('INVALID_COMMERCIAL_AMOUNT');
      const partyId=await resolvePointsOwner(client,cmd.userId);
      await lockPointsOwner(client,partyId);
      const {rows:[previous]}=await client.query('SELECT * FROM konektag.points_merchant_consumptions WHERE operation_key=$1',[cmd.idempotencyKey]);
      if(previous) {
        if(previous.party_id!==partyId || previous.merchant_profile_id!==cmd.merchantProfileId || Number(previous.quantity)!==cmd.quantityK
          || Number(previous.transaction_amount_minor)!==cmd.amount || previous.transaction_currency!==cmd.currency) throw new Error('POINTS_CONSUMPTION_REPLAY_CONFLICT');
        if(ownsTransaction) await client.query('COMMIT');
        return {success:true,financialTransactionId:previous.monetary_transaction_id};
      }
      const hold=await reservePoints(client,{partyId,operationKey:cmd.idempotencyKey,quantity:cmd.quantityK,expiresAt:new Date(Date.now()+30*60*1000)});
      const kyb = await new MerchantKybService(client).requireMerchantApproved(cmd.merchantProfileId);
      if (!kyb.approved) throw new Error(`MERCHANT_KYB_REQUIRED: ${kyb.reason}`);
      const merchant = await getMerchantInfo(client, cmd.merchantProfileId);
      const user = await getUserInfo(client, cmd.userId);
      const userCountry = user.country;
      const corridorId = `${userCountry}-${merchant.country}`;

      const profileId = await getRegulatoryProfile(client, 'consumption', userCountry, merchant.country);
      if (!profileId) {
        if (ownsTransaction) await client.query('ROLLBACK');
        return { success: false, error: `Aucun profil reglementaire pour consumption ${userCountry}->${merchant.country}` };
      }

      // The regulated operation, sale and debt all use this same database transaction.
      const ftResult = await new FinancialOperationService(client, false).execute({
        idempotencyKey: cmd.idempotencyKey,
        operationId: `CONSUME-${cmd.merchantSaleRef}`,
        operation: 'consumption',
        userId: cmd.userId,
        keycloakId: user.keycloakId,
        countryOfOrigin: userCountry,
        countryOfDestination: merchant.country,
        rail: 'internal',
         corridorId,
        regulatoryProfileId: profileId,
        currency: cmd.currency,
        amount: cmd.amount,
        klotId: cmd.klotId,
        klotQuantity: cmd.klotQuantity,
        entries: [
          { accountCode: '8000', side: 'debit', amount: cmd.amount, description: `Règlement marchand — ${cmd.merchantSaleRef}` },
          { clientId: cmd.merchantProfileId, accountCode: '2000', side: 'credit', amount: cmd.amount, description: `Vente ${cmd.merchantSaleRef} — dette marchand brute` },
        ],
      });

      if (!ftResult.success) throw new Error(ftResult.error || 'CONSUMPTION_REJECTED');

      const kTransactionId=await consumeReservedPoints(client,{partyId,reservationId:hold.id,operationKey:`points-consumption:${hold.id}`,
        quantity:cmd.quantityK,corridorId,regulatoryProfileId:profileId});
      await recordMerchantPointsConsumption(client,{operationKey:cmd.idempotencyKey,partyId,merchantId:cmd.merchantProfileId,
        legalEntityId:null,quantity:cmd.quantityK,transactionAmountMinor:cmd.amount,transactionCurrency:cmd.currency,
        paymentValuationProofHash:cmd.quantityValuationProofHash,
        kTransactionId,monetaryTransactionId:ftResult.financialTransactionId,reservationId:hold.id,rail:cmd.rail,paymentCountry:cmd.paymentCountry});

      // 2. Create MerchantSale record
      const { rows: [sale] } = await client.query(
        `INSERT INTO konektag.merchant_sales (sale_ref, merchant_profile_id, legal_entity_id, transaction_id, gross_amount, net_amount, commission_amount, commission_rate, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CREATED')
         ON CONFLICT (sale_ref) DO NOTHING
         RETURNING id`,
        [cmd.merchantSaleRef, cmd.merchantProfileId, null, ftResult.financialTransactionId,
          cmd.amount, cmd.amount, 0, 0, cmd.currency],
      );

      // Merchant principal never creates an intercompany position merely because
      // payer and merchant countries differ. Intercompany belongs to separately
      // identified Konektag revenue/fee accounting.
      let intercompanyPositionId: string | undefined;
      if (ownsTransaction) await client.query('COMMIT');
      return {
        success: true,
        financialTransactionId: ftResult.financialTransactionId,
        merchantSaleId: sale?.id,
        intercompanyPositionId,
      };
    } catch (e: any) {
      if (ownsTransaction) await client.query('ROLLBACK');
      return { success: false, error: e.message };
    } finally {
      if (ownsTransaction) client.release();
    }
  },
};
