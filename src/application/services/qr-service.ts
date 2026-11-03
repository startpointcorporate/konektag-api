import pool from '../../infrastructure/database/pool.ts';
import { merchantActivationService } from './merchant-activation-service.ts';
import crypto from 'node:crypto';
import { resolveMerchantOperationCurrency, resolveUserOperationCurrency } from './operation-currency-service.ts';
import { QrPaymentSchema } from '../shared/core02/contracts.ts';
import { base64urlDecode } from '../shared/core02/crypto.ts';
import { verifySignedQrServer } from './qr-signed-verification-service.ts';
import { PointsQuantityError, verifyFixedQrQuantity } from './pay/qr-points-quantity.ts';
import { PointsKValuationError } from './points-k-valuation-service.ts';

export class QRValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QRValidationError';
  }
}

export const qrService = {
  /**
   * Créer un QR code.
   * - Mode commerçant (merchantProfileId fourni) : vérifie membership + statut de publication
   * - Mode personnel (sans merchantProfileId) : tout utilisateur authentifié
   */
  async createQR(params: {
    merchantProfileId?: string;
    userId: string;
    qrType: 'Static' | 'Dynamic';
    amount?: number;
    reference?: string;
    terminal?: string;
    expiresInMinutes?: number;
    signedToken?: string;
  }) {
    const variableAmount = params.qrType === 'Static' && params.amount === undefined;
    if (params.amount !== undefined && (!Number.isSafeInteger(params.amount) || params.amount <= 0)) {
      throw new QRValidationError('Montant invalide');
    }
    if (params.qrType === 'Dynamic' && params.amount === undefined) {
      throw new QRValidationError('Montant requis pour un QR dynamique');
    }
    let etablissementId: string;
    let merchantProfileId: string | null = null;
    let qrDataPayload: Record<string, any>;
    let currency: string;

    if (params.merchantProfileId) {
      // ── Mode commerçant ──
      const { rows: [member] } = await pool.query(
        `SELECT mm.role FROM konektag.merchant_memberships mm
         JOIN konektag.merchant_profiles mp ON mp.id = mm.merchant_profile_id
         WHERE mm.merchant_profile_id = $1 AND mm.user_id = $2
           AND mm.status = 'active' AND mm.role IN ('owner', 'manager')
           AND mp.deleted_at IS NULL`,
        [params.merchantProfileId, params.userId],
      );
      if (!member) throw new QRValidationError('Accès refusé : vous n êtes pas responsable de ce commerce');

      const { rows: [profile] } = await pool.query(
        `SELECT id FROM konektag.merchant_profiles
         WHERE id = $1 AND deleted_at IS NULL`,
        [params.merchantProfileId],
      );
      if (!profile) throw new QRValidationError('Commerce introuvable');

      const activation = await merchantActivationService.requireMerchantApproved(params.merchantProfileId);
      if (!activation.ok) throw new QRValidationError(activation.error || 'MERCHANT_NOT_ACTIVATED');

      // QR payment identifies the merchant with the Konektag profile itself.
      etablissementId = profile.id;
      merchantProfileId = params.merchantProfileId;
      currency = (await resolveMerchantOperationCurrency(pool, params.merchantProfileId)).currency;
      qrDataPayload = { t: params.qrType, e: etablissementId, a: params.amount, r: params.reference };
    } else {
      // ── Mode personnel ──
      etablissementId = params.userId;
      currency = (await resolveUserOperationCurrency(pool, params.userId)).currency;
      qrDataPayload = { t: params.qrType, p: 'personal', u: params.userId, a: params.amount, r: params.reference };
    }

    const id = crypto.randomUUID();
    if (!params.signedToken || params.signedToken.split('.').length !== 3) {
      throw new QRValidationError('SIGNED_QR_REQUIRED');
    }
    const token = params.signedToken;
    let signedPayload: any;
    try { signedPayload = await verifySignedQrServer(token); }
    catch (error) {
      throw new QRValidationError(error instanceof Error && error.message === 'QR_CONTRACT_OUTDATED' ? 'QR_CONTRACT_OUTDATED' : 'SIGNED_QR_INVALID');
    }
    const name = signedPayload.requestId;
    if (signedPayload.beneficiaryType !== (merchantProfileId ? 'MERCHANT' : 'USER')
      || signedPayload.beneficiaryId !== (merchantProfileId || params.userId)
      || signedPayload.currency !== currency
      || signedPayload.variableAmount !== variableAmount
      || (!variableAmount && signedPayload.amount !== (params.amount || 0))) {
      throw new QRValidationError('SIGNED_QR_TARGET_MISMATCH');
    }
    // A fixed QR's signed quantity must match the official valuation at issuance.
    if (!variableAmount) {
      try { await verifyFixedQrQuantity(pool, signedPayload); }
      catch (error) {
        if (error instanceof PointsQuantityError || error instanceof PointsKValuationError) throw new QRValidationError(error.code);
        throw error;
      }
    }
    const expiresAt = new Date(Date.now() + (params.expiresInMinutes || 15) * 60 * 1000);
    qrDataPayload = {
      type: 'qr_payment', qr: name, amount: params.amount || 0,
      reference: params.reference || '', currency,
      owner_user_id: merchantProfileId ? undefined : params.userId,
      signedQrToken: token,
    };
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let shortCode='';
    for(let attempt=0;attempt<8;attempt++){
      const bytes=crypto.randomBytes(8); let raw=''; for(let i=0;i<8;i++) raw+=alphabet[bytes[i]%alphabet.length];
      const candidate=raw.slice(0,4)+'-'+raw.slice(4);
      const exists=await pool.query(`SELECT 1 FROM konektag.checkout_intents WHERE qr_short_code=$1 LIMIT 1`,[candidate]);
      if(!exists.rowCount){shortCode=candidate;break;}
    }
    if(!shortCode) throw new QRValidationError('QR_SHORT_CODE_UNAVAILABLE');
    await pool.query(
      `INSERT INTO konektag.checkout_intents
       (id, token_hash, merchant_profile_id, owner_user_id, amount, currency,
        service_description, expiration, status, usage_unique, source_type,
        public_id, reference, terminal, qr_type, qr_request_id, qr_beneficiary_type,
        qr_beneficiary_id, qr_issuer_device_id, qr_key_id, qr_key_version, qr_short_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ISSUED', $9, 'qr', $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [id, tokenHash, merchantProfileId, merchantProfileId ? null : params.userId,
        params.amount || 0, currency, params.reference || null, expiresAt,
        signedPayload.singleUse, name, params.reference || null, params.terminal || null, params.qrType,
        signedPayload.requestId, signedPayload.beneficiaryType, signedPayload.beneficiaryId,
        signedPayload.issuerDeviceId, signedPayload.keyId, signedPayload.keyVersion, shortCode],
    );
    return mapQr({ id, merchant_profile_id: merchantProfileId, owner_user_id: merchantProfileId ? null : params.userId,
      amount: params.amount || 0, currency, service_description: params.reference || null,
      expiration: expiresAt, status: 'ISSUED', usage_unique: signedPayload.singleUse,
      public_id: name, reference: params.reference || null, terminal: params.terminal || null,
      qr_type: params.qrType, created_at: new Date().toISOString(), qr_data: qrDataPayload, etablissement: etablissementId, qr_short_code: shortCode });
  },

  async getQRByShortCode(code: string) {
    const normalized=code.trim().toUpperCase();
    if(!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(normalized)) throw new QRValidationError('QR_CODE_INVALID');
    const {rows:[row]}=await pool.query(`SELECT ci.* FROM konektag.checkout_intents ci WHERE ci.qr_short_code=$1 AND ci.source_type='qr'`,[normalized]);
    if(!row) throw new QRValidationError('QR_NOT_FOUND');
    if(row.status!=='ISSUED' || new Date(row.expiration).getTime()<=Date.now()) throw new QRValidationError('QR_EXPIRED_OR_USED');
    return mapQr(row);
  },

  async getQR(name: string) {
    const { rows: [row] } = await pool.query(
      `SELECT ci.*
       FROM konektag.checkout_intents ci
       WHERE ci.public_id = $1 AND ci.source_type = 'qr'`, [name]);
    if (!row) throw new QRValidationError('QR_NOT_FOUND');
    return mapQr(row);
  },

  async listClientPayments(clientId: string, limit = 20) {
    const { rows } = await pool.query(
      `SELECT ci.* FROM konektag.checkout_intents ci
       WHERE ci.payer_user_id = $1 AND ci.status = 'CONSUMED' AND ci.source_type = 'qr'
       ORDER BY ci.consumed_at DESC LIMIT $2`, [clientId, limit]);
    return rows.map(mapPayment);
  },

  async listMerchantPayments(merchantProfileId: string, limit = 50) {
    const { rows } = await pool.query(
      `SELECT ci.* FROM konektag.checkout_intents ci
       JOIN konektag.merchant_profiles mp ON mp.id = ci.merchant_profile_id
       WHERE ci.merchant_profile_id = $1 AND ci.status = 'CONSUMED' AND ci.source_type = 'qr'
       ORDER BY ci.consumed_at DESC LIMIT $2`, [merchantProfileId, limit]);
    return rows.map(mapPayment);
  },

  async listMerchantQRCodes(merchantProfileId: string, limit = 50) {
    const { rows } = await pool.query(
      `SELECT ci.* FROM konektag.checkout_intents ci
       JOIN konektag.merchant_profiles mp ON mp.id = ci.merchant_profile_id
       WHERE ci.merchant_profile_id = $1 AND ci.source_type = 'qr'
       ORDER BY ci.created_at DESC LIMIT $2`, [merchantProfileId, limit]);
    return rows.map(mapQr);
  },

  async resolveMerchantFromEtablissement(etablissement: string): Promise<string> {
    const { rows } = await pool.query(
      `SELECT id FROM konektag.merchant_profiles
       WHERE id::text = $1 AND deleted_at IS NULL LIMIT 2`,
      [etablissement],
    );
    if (!rows.length) throw new QRValidationError('QR_MERCHANT_NOT_FOUND');
    if (rows.length !== 1) throw new QRValidationError('QR_MERCHANT_AMBIGUOUS');
    return rows[0].id;
  },
};

function mapQr(row: any) {
  const expired = !row.expiration || !Number.isFinite(new Date(row.expiration).getTime())
    || new Date(row.expiration).getTime() <= Date.now();
  const status = row.status === 'CONSUMED' ? 'Used' : row.status === 'EXPIRED' || expired ? 'Expired'
    : row.status === 'ISSUED' ? 'Active' : 'Inactive';
  const etablissement = row.merchant_profile_id || row.etablissement || row.owner_user_id || '';
  const qrData = row.qr_data || { type: 'qr_payment', qr: row.public_id || row.id, amount: Number(row.amount),
    reference: row.reference || '', currency: row.currency, owner_user_id: row.owner_user_id || undefined };
  return { name: row.public_id || row.id, etablissement, qr_type: row.qr_type || 'Dynamic',
    amount: Number(row.amount), reference: row.reference || '', terminal: row.terminal || '',
    expires_at: row.expiration, status, qr_data: JSON.stringify(qrData), creation: row.created_at,
    merchant_profile_id: row.merchant_profile_id, owner_user_id: row.owner_user_id, currency: row.currency, short_code: row.qr_short_code || undefined };
}

function mapPayment(row: any) {
  return { name: row.operation_id || row.financial_transaction_id, qr_code: row.public_id || row.id,
    client: row.payer_user_id, etablissement: row.merchant_profile_id || row.owner_user_id,
    amount: Number(row.amount), payment_method: 'Solde Konektag', status: 'Paid',
    payment_time: row.consumed_at, financial_transaction_id: row.financial_transaction_id, currency: row.currency };
}
