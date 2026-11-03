import crypto from 'node:crypto';
import pool from '../../infrastructure/database/pool.ts';
import { getCorrelationId } from '../../infrastructure/correlation-id.ts';

export interface RechargeInput {
  keycloakId: string;
  clientEmail: string;
  amount: number;
  currency: string;
  paymentMethod: 'Mobile Money' | 'Stripe' | 'Google Pay' | 'Apple Pay' | 'Crypto';
  country: string;
  operator?: string;
  phoneNumber?: string;
  cryptoNetwork?: string;
  cryptoAddress?: string;
}

type RechargeCreationResult = {
  doc: Record<string, unknown> & { name: string };
  projectionStatus: 'accepted' | 'pending_reconciliation';
};

function toPaymentMethodType(method: string): 'card' | 'mobile_money' | 'crypto' {
  const map: Record<string, 'card' | 'mobile_money' | 'crypto'> = {
    'Mobile Money': 'mobile_money', 'Stripe': 'card',
    'Google Pay': 'card', 'Apple Pay': 'card', 'Crypto': 'crypto',
  };
  return map[method] || 'card';
}

function mapProvider(method: string, operator?: string, cryptoNetwork?: string): string | null {
  if (method === 'Mobile Money') {
    if (!operator) return null;
    const op = operator.toUpperCase();
    if (op.includes('MTN')) return 'MTN';
    if (op.includes('ORANGE')) return 'ORANGE';
    if (op.includes('AIRTEL')) return 'AIRTEL';
    if (op.includes('MOOV')) return 'MOOV';
    if (op.includes('WAVE')) return 'WAVE';
    if (op.includes('MPESA') || op.includes('M_PESA')) return 'M_PESA';
    if (op.includes('VODACOM')) return 'VODACOM';
    return operator;
  }
  if (method === 'Crypto') {
    if (!cryptoNetwork) return 'USDT_TRC20';
    const net = cryptoNetwork.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const known: Record<string, string> = {
      'USDT': 'USDT_TRC20', 'USDT_ERC20': 'USDT_ERC20',
      'ERC20': 'USDT_ERC20', 'TRC20': 'USDT_TRC20',
      'BEP20': 'USDT_BEP20', 'BTC': 'BTC', 'ETH': 'ETH',
      'BITCOIN': 'BTC', 'ETHEREUM': 'ETH',
    };
    return known[net] || cryptoNetwork;
  }
  return 'STRIPE';
}

export const rechargeService = {
  async createRecharge(input: RechargeInput & { status?: string; confirmedAt?: string }): Promise<RechargeCreationResult> {
    const aggregateId = crypto.randomUUID();
    const rechargeName = `KTG-RECH-${aggregateId}`;
    const correlationId = getCorrelationId() || crypto.randomUUID();
    const currency = input.currency.toUpperCase();
    const payload = {
      rechargeName,
      keycloakId: input.keycloakId,
      requestedAmount: input.amount,
      requestedCurrency: currency,
      paymentMethod: toPaymentMethodType(input.paymentMethod),
      paymentProvider: mapProvider(input.paymentMethod, input.operator, input.cryptoNetwork),
      country: input.country,
      internalReference: rechargeName,
      mobileMoneyOperator: input.operator || null,
      mobileMoneyPhone: input.phoneNumber || null,
      cryptoNetwork: input.cryptoNetwork || null,
      cryptoAddress: input.cryptoAddress || null,
      providerReference: input.paymentMethod === 'Crypto' ? input.cryptoAddress || null : null,
      correlationId,
    };

    await pool.query(
      `INSERT INTO konektag.outbox_events
       (correlation_id, aggregate_type, aggregate_id, aggregate_ref, event_type, event_version, payload)
       VALUES ($1, 'Recharge', $2, $3, 'RechargeCreated', 1, $4)`,
      [correlationId, aggregateId, rechargeName, JSON.stringify(payload)],
    );

    return {
      doc: {
        name: rechargeName,
        keycloak_id: input.keycloakId,
        client_email: input.clientEmail,
        amount: input.amount,
        currency,
        payment_method: input.paymentMethod,
        country: input.country,
        operator: input.operator || null,
        phone_number: input.phoneNumber || null,
        crypto_network: input.cryptoNetwork || null,
        crypto_address: input.cryptoAddress || null,
        reference: rechargeName,
        status: input.status || 'Pending',
      },
      projectionStatus: 'accepted',
    };
  },
};
