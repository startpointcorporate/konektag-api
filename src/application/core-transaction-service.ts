import { publicMarketplaceCtes } from './services/public-marketplace-sql.ts';
import crypto from 'node:crypto';
import { notifyMerchantTransaction } from './services/notification-service.ts';
import type { PoolClient } from 'pg';
import pool from '../infrastructure/database/pool.ts';
import { assertMoney, type Money } from './services/pay/money-unit.ts';
import { CORE_CONTRACT_VERSION, nextTransactionState, type TransactionKind, type TransitionCommand } from '../domain/core-business.ts';
import { listActivePromotions, loadActivePromotion, type PromotionSnapshot } from './promotion-service.ts';

export interface NewLine { offerId?: string; pricingRuleId?: string; label: string; quantity: number; unitPrice?: Money }
interface ResolvedLine extends NewLine {
  unitPrice: Money; pricingCountry?: string; subtotalMinor: number; discountMinor: number;
  taxRateBasisPoints: number; taxMinor: number; totalMinor: number; fiscalSnapshotVersion: number; category?: string;
}
export interface NewTransaction {
  merchantProfileId: string; customerUserId: string | null; merchantActorUserId?: string; catalogCheckout?: boolean; kind: TransactionKind; requestKey: string;
  lines: NewLine[]; scheduledAt?: string; note?: string; promotionId?: string; promotionFingerprint?: string;
}
export interface AllocationRequest { transactionLineId: string; availabilityId: string; units: number }

function requiredPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('INVALID_QUANTITY');
}
function validateInput(input: NewTransaction) {
  if(input.catalogCheckout && (!input.customerUserId || input.lines.some(l=>!l.offerId||!l.pricingRuleId||l.unitPrice)))throw new Error('INVALID_CATALOG_TRANSACTION');
  if (input.merchantActorUserId) {
    if (input.customerUserId !== null || input.lines.some(line => !line.offerId || !line.pricingRuleId || line.unitPrice)) throw new Error('INVALID_MERCHANT_TRANSACTION');
  } else if (!input.customerUserId) throw new Error('INVALID_TRANSACTION');
  if (!['ORDER', 'RESERVATION', 'REQUEST'].includes(input.kind) || !input.requestKey || !input.lines.length) throw new Error('INVALID_TRANSACTION');
  for (const line of input.lines) {
    requiredPositiveInteger(line.quantity);
    if (!line.label.trim() || (line.pricingRuleId && !line.offerId)) throw new Error('INVALID_LINE');
    if (!line.pricingRuleId && !line.unitPrice) throw new Error('INVALID_LINE');
    if (line.unitPrice && !line.pricingRuleId) assertMoney(line.unitPrice);
  }
}
function fixedMinor(value: number, currency: string): number {
  const amount = ['XAF', 'XOF', 'GNF'].includes(currency) ? value : Math.round(value * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('INVALID_PROMOTION');
  return amount;
}

export function calculatePromotionDiscounts(lines: Array<{ subtotalMinor: number; category?: string }>, promotion: PromotionSnapshot | null, currency: string): number[] {
  const discounts = lines.map(() => 0);
  if (!promotion) return discounts;
  const category = promotion.category.toLowerCase();
  const eligible = lines.map((line, index) => category === 'general' || (line.category ?? '').toLowerCase() === category ? index : -1).filter(index => index >= 0);
  const eligibleSubtotal = eligible.reduce((sum, index) => sum + lines[index].subtotalMinor, 0);
  if (!eligible.length || eligibleSubtotal <= 0) return discounts;
  const requested = promotion.discountType === 'percentage'
    ? Math.floor(eligibleSubtotal * promotion.discountValue / 100)
    : fixedMinor(promotion.discountValue, currency);
  let remaining = Math.min(Math.max(requested, 0), eligibleSubtotal);
  for (const index of eligible) {
    const share = index === eligible[eligible.length - 1]
      ? remaining
      : Math.min(lines[index].subtotalMinor, Math.floor(requested * lines[index].subtotalMinor / eligibleSubtotal));
    discounts[index] = Math.min(lines[index].subtotalMinor, Math.max(0, share));
    remaining -= discounts[index];
  }
  return discounts;
}

export async function resolveLines(client: PoolClient, input: NewTransaction): Promise<{ lines: ResolvedLine[]; currency: string; subtotal: number; discount: number; tax: number; total: number; country?: string; promotion: PromotionSnapshot | null }> {
  if(input.catalogCheckout) {
    const {rowCount}=await client.query(`${publicMarketplaceCtes} SELECT p.id FROM konektag.merchant_products p JOIN public_products published ON published.id=p.id AND published.merchant_profile_id=p.merchant_profile_id JOIN konektag.merchant_profiles mp ON mp.id=p.merchant_profile_id
      WHERE p.merchant_profile_id=$1 AND p.id=ANY($2::uuid[]) AND p.deleted_at IS NULL AND mp.deleted_at IS NULL AND mp.status IN ('Published','Referenced')
      AND COALESCE(p.catalog_metadata->>'status','active')='active' AND COALESCE(p.catalog_metadata->>'visibility','public')='public'
      AND published.deleted_at IS NULL AND COALESCE(published.catalog_metadata->>'status','active')='active'
      AND COALESCE(published.catalog_metadata->>'visibility','public')='public' FOR SHARE OF p,mp`,[input.merchantProfileId,input.lines.map(l=>l.offerId)]);
    if(rowCount!==new Set(input.lines.map(l=>l.offerId)).size)throw new Error('INVALID_CATALOG_PRODUCT');
  }
  const lines: ResolvedLine[] = [];
  let currency: string | undefined;
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  let total = 0;
  let pricingCountry: string | undefined;
  if ((input.merchantActorUserId || input.catalogCheckout)) {
    const { rows: [context] } = await client.query<{ country: string | null }>(
      `SELECT COALESCE(NULLIF(upper(le.country_code), ''), NULLIF(upper(mp.country), '')) AS country
       FROM konektag.merchant_profiles mp
       LEFT JOIN konektag.legal_entities le ON le.id=mp.legal_entity_id AND le.deleted_at IS NULL
       WHERE mp.id=$1 AND mp.deleted_at IS NULL`, [input.merchantProfileId]);
    pricingCountry = context?.country ?? undefined;
    if (!pricingCountry) throw new Error('PRICING_COUNTRY_UNAVAILABLE');
  }
  const pricedGroups = new Map<string, { offerId: string; pricingRuleId: string; quantity: number }>();
  for (const line of input.lines) {
    if (!line.pricingRuleId) continue;
    const key = JSON.stringify([line.offerId, line.pricingRuleId]);
    const group = pricedGroups.get(key) ?? { offerId: line.offerId!, pricingRuleId: line.pricingRuleId, quantity: 0 };
    group.quantity += line.quantity;
    if (!Number.isSafeInteger(group.quantity)) throw new Error('INVALID_QUANTITY');
    pricedGroups.set(key, group);
  }
  const prices = new Map<string, Money>();
  const labels = new Map<string, string>();
  const categories = new Map<string, string | undefined>();
  for (const [key, group] of pricedGroups) {
    const { rows: [rule] } = await client.query<{ unit_price: number; currency: string; min_quantity: number | null; max_quantity: number | null; name: string; category: string | null }>(
      `${input.catalogCheckout ? publicMarketplaceCtes : ''} SELECT r.unit_price, r.currency, r.min_quantity, r.max_quantity, ${input.catalogCheckout ? 'published.name' : 'p.name'} AS name, oc.code AS category
       FROM konektag.product_pricing_rules r
       JOIN konektag.merchant_products p ON p.id=r.merchant_product_id AND p.merchant_profile_id=r.merchant_profile_id
       ${input.catalogCheckout ? 'JOIN public_products published ON published.id=p.id AND published.merchant_profile_id=p.merchant_profile_id' : ''}
       JOIN konektag.offer_categories oc ON oc.id=p.offer_category_id AND oc.deleted_at IS NULL
       WHERE r.id=$1 AND r.merchant_profile_id=$2 AND r.merchant_product_id=$3
         AND r.deleted_at IS NULL AND p.deleted_at IS NULL AND r.status='APPROVED'
         AND r.valid_from <= CURRENT_DATE AND (r.valid_until IS NULL OR r.valid_until >= CURRENT_DATE)
       FOR SHARE OF r, p`,
      [group.pricingRuleId, input.merchantProfileId, group.offerId]);
    if (!rule) throw new Error('INVALID_PRICING_RULE');
    if ((rule.min_quantity !== null && group.quantity < rule.min_quantity) ||
        (rule.max_quantity !== null && group.quantity > rule.max_quantity)) throw new Error('INVALID_PRICING_RULE');
    const authoritative = { amountMinor: Number(rule.unit_price), currency: rule.currency };
    assertMoney(authoritative);
    prices.set(key, authoritative);
    labels.set(key, rule.name);
    categories.set(key, rule.category ?? undefined);
  }
  for (const line of input.lines) {
    let unitPrice = line.unitPrice;
    if (line.pricingRuleId) {
      const authoritative = prices.get(JSON.stringify([line.offerId, line.pricingRuleId]))!;
      if (unitPrice && (unitPrice.amountMinor !== authoritative.amountMinor || unitPrice.currency !== authoritative.currency)) {
        throw new Error('PRICE_MISMATCH');
      }
      unitPrice = authoritative;
    }
    if (!unitPrice) throw new Error('INVALID_LINE');
    if (currency && unitPrice.currency !== currency) throw new Error('INVALID_LINE');
    currency = unitPrice.currency;
    const lineSubtotal = line.quantity * unitPrice.amountMinor;
    if (!Number.isSafeInteger(lineSubtotal)) throw new Error('AMOUNT_OUT_OF_RANGE');
    let taxRateBasisPoints = 0;
    let taxMinor = 0;
    let lineCountry = (input.merchantActorUserId || input.catalogCheckout) ? pricingCountry : undefined;
    if ((input.merchantActorUserId || input.catalogCheckout)) {
      const { rows: taxRules } = await client.query<{ rate_basis_points: number }>(
        `SELECT rate_basis_points FROM (
           SELECT DISTINCT ON (tax_code) rate_basis_points, enabled, valid_from, valid_until
           FROM konektag.merchant_product_tax_rules
           WHERE merchant_profile_id=$1 AND merchant_product_id=$2
             AND (pricing_rule_id=$3 OR pricing_rule_id IS NULL) AND country_code=$4
             AND deleted_at IS NULL
           ORDER BY tax_code, pricing_rule_id NULLS LAST, version DESC
         ) latest
         WHERE enabled AND valid_from<=CURRENT_DATE
           AND (valid_until IS NULL OR valid_until>=CURRENT_DATE)`,
        [input.merchantProfileId, line.offerId, line.pricingRuleId, pricingCountry]);
      taxRateBasisPoints = taxRules.reduce((sum, rule) => sum + Number(rule.rate_basis_points), 0);
      if (taxRateBasisPoints > 10000) throw new Error('INVALID_TAX_CONFIGURATION');
      taxMinor = Math.round(lineSubtotal * taxRateBasisPoints / 10000);
    }
    subtotal += lineSubtotal;
    lines.push({ ...line, label: (input.merchantActorUserId || input.catalogCheckout) ? labels.get(JSON.stringify([line.offerId, line.pricingRuleId]))! : line.label, unitPrice,
      pricingCountry: lineCountry, subtotalMinor: lineSubtotal, discountMinor: 0, taxRateBasisPoints,
      taxMinor, totalMinor: lineSubtotal + taxMinor, fiscalSnapshotVersion: 1,
      category: categories.get(JSON.stringify([line.offerId, line.pricingRuleId])) });
  }
  const activePromotions = await listActivePromotions(client, input.merchantProfileId);
  const applicable = activePromotions.filter(candidate => lines.some(line => candidate.category.toLowerCase() === 'general' ||
    (line.category ?? '').toLowerCase() === candidate.category.toLowerCase()));
  if (applicable.length > 1) throw new Error('PROMOTION_CONFLICT');
  const promotion = input.promotionId
    ? await loadActivePromotion(client, input.merchantProfileId, input.promotionId)
    : applicable[0] ?? null;
  if (input.promotionId && (!applicable.length || applicable[0].id !== promotion?.id)) throw new Error('PROMOTION_NOT_APPLICABLE');
  if (promotion && input.promotionFingerprint && promotion.fingerprint !== input.promotionFingerprint) throw new Error('PROMOTION_VERSION_CONFLICT');
  const discounts = calculatePromotionDiscounts(lines, promotion, currency!);
  discount = discounts.reduce((sum, value) => sum + value, 0);
  tax = 0; total = 0;
  for (let index = 0; index < lines.length; index++) {
    const resolved = lines[index];
    resolved.discountMinor = discounts[index];
    resolved.taxMinor = Math.round((resolved.subtotalMinor - resolved.discountMinor) * resolved.taxRateBasisPoints / 10000);
    resolved.totalMinor = resolved.subtotalMinor - resolved.discountMinor + resolved.taxMinor;
    tax += resolved.taxMinor;
    total += resolved.totalMinor;
  }
  if (![subtotal, discount, tax, total].every(Number.isSafeInteger) || discount < 0 || discount > subtotal) throw new Error('AMOUNT_OUT_OF_RANGE');
  return { lines, currency: currency!, subtotal, discount, tax, total, country: pricingCountry, promotion };
}
export async function requireCoreMerchantActor(client: PoolClient, merchantId: string, actorId: string): Promise<void> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM konektag.merchant_profiles mp WHERE mp.id = $1 AND mp.deleted_at IS NULL
       AND (mp.user_id = $2 OR EXISTS (SELECT 1 FROM konektag.merchant_memberships mm
         WHERE mm.merchant_profile_id = mp.id AND mm.user_id = $2 AND mm.status = 'active'
           AND mm.role IN ('owner','manager')))`, [merchantId, actorId]);
  if (!rowCount) throw new Error('MERCHANT_ACCESS_DENIED');
}

export async function createCoreTransaction(input: NewTransaction): Promise<string> {
  validateInput(input);
  const hash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.merchantActorUserId) await requireCoreMerchantActor(client, input.merchantProfileId, input.merchantActorUserId);
    const existing = await client.query<{ id: string; request_hash: string; customer_user_id: string }>(
      `SELECT id, request_hash, customer_user_id FROM konektag.core_transactions
       WHERE merchant_profile_id=$1 AND request_key=$2`, [input.merchantProfileId, input.requestKey]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== hash || existing.rows[0].customer_user_id !== input.customerUserId) throw new Error('IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');
      return existing.rows[0].id;
    }
    const { lines, currency, subtotal, discount, tax, total, country, promotion } = await resolveLines(client, input);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO konektag.core_transactions
       (merchant_profile_id, customer_user_id, kind, currency, total_minor, request_key, request_hash, scheduled_at, note, created_by_user_id,
        pricing_country, subtotal_minor, discount_minor, tax_minor, fiscal_snapshot_version, promotion_id, promotion_fingerprint, promotion_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,$17)
       ON CONFLICT (merchant_profile_id, request_key) DO NOTHING RETURNING id`,
      [input.merchantProfileId, input.customerUserId, input.kind, currency, total, input.requestKey, hash,
       input.scheduledAt ?? null, input.note ?? null, input.merchantActorUserId ?? null,
       country ?? null, subtotal, discount, tax, promotion?.id ?? null, promotion?.fingerprint ?? null,
       promotion ? JSON.stringify({ ...promotion, discountMinor: discount, lineDiscounts: lines.map(line => line.discountMinor) }) : null]);
    let id = inserted.rows[0]?.id;
    if (!id) {
      const { rows } = await client.query<{ id: string; request_hash: string; customer_user_id: string }>(
        `SELECT id, request_hash, customer_user_id FROM konektag.core_transactions
         WHERE merchant_profile_id = $1 AND request_key = $2`, [input.merchantProfileId, input.requestKey]);
      if (rows[0]?.request_hash !== hash || rows[0]?.customer_user_id !== input.customerUserId) throw new Error('IDEMPOTENCY_CONFLICT');
      id = rows[0].id;
    } else {
      for (const line of lines) {
        await client.query(
          `INSERT INTO konektag.core_transaction_lines
           (transaction_id, merchant_profile_id, offer_id, pricing_rule_id, label, quantity, unit_amount_minor, currency,
            pricing_country, unit_price_minor, subtotal_minor, discount_minor, tax_rate_basis_points, tax_minor, total_minor, fiscal_snapshot_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1)`,
          [id, input.merchantProfileId, line.offerId ?? null, line.pricingRuleId ?? null,
           line.label, line.quantity, line.unitPrice.amountMinor, currency, line.pricingCountry ?? null,
           line.unitPrice.amountMinor, line.subtotalMinor, line.discountMinor, line.taxRateBasisPoints,
           line.taxMinor, line.totalMinor]);
      }
    }
    if (inserted.rows[0] && input.merchantActorUserId) {
      await client.query(`INSERT INTO konektag.core_transition_journal
        (transaction_id,merchant_profile_id,actor_user_id,command_key,command,command_hash,from_state,to_state,from_version,to_version)
        VALUES ($1,$2,$3,$4,'CREATE',$5,'CREATED','CREATED',0,1)`,
        [id,input.merchantProfileId,input.merchantActorUserId,`create:${input.requestKey}`,hash]);
      await notifyMerchantTransaction(client, { merchantProfileId: input.merchantProfileId, transactionId: id!, version: 1, state: 'CREATED' });
    }
    await client.query('COMMIT');
    return id!;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function transitionCoreTransaction(input: {
  transactionId: string; merchantProfileId: string; actorUserId: string; expectedVersion: number;
  commandKey: string; command: TransitionCommand; allocations?: AllocationRequest[];
}): Promise<{ state: string; version: number }> {
  if (!input.commandKey || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('INVALID_COMMAND');
  const commandHash = crypto.createHash('sha256').update(JSON.stringify({
    command: input.command, expectedVersion: input.expectedVersion, allocations: input.allocations ?? null,
  })).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireCoreMerchantActor(client, input.merchantProfileId, input.actorUserId);
    const result = await client.query<{ state: string; state_version: number; kind: TransactionKind }>(
      `SELECT state, state_version, kind FROM konektag.core_transactions
       WHERE id = $1 AND merchant_profile_id = $2 FOR UPDATE`, [input.transactionId, input.merchantProfileId]);
    const row = result.rows[0];
    if (!row) throw new Error('TRANSACTION_NOT_FOUND');
    const replay = await client.query<{ command_hash: string; to_state: string; to_version: number }>(
      `SELECT command_hash, to_state, to_version FROM konektag.core_transition_journal
       WHERE transaction_id = $1 AND command_key = $2`, [input.transactionId, input.commandKey]);
    if (replay.rows[0]) {
      if (replay.rows[0].command_hash !== commandHash) throw new Error('IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');
      return { state: replay.rows[0].to_state, version: replay.rows[0].to_version };
    }
    if (row.state_version !== input.expectedVersion) throw new Error('VERSION_CONFLICT');
    const next = nextTransactionState(row.kind, row.state as Parameters<typeof nextTransactionState>[1], input.command);
    if (input.command === 'ALLOCATE') {
      const allocations = input.allocations;
      if (!allocations?.length) throw new Error('ALLOCATION_REQUIRED');
      for (const allocation of allocations) requiredPositiveInteger(allocation.units);
      const availabilityIds = [...new Set(allocations.map(a => a.availabilityId))].sort();
      const availabilities = await client.query<{ id: string; available_units: number }>(
        `SELECT id, available_units FROM konektag.core_availabilities
         WHERE id=ANY($1::uuid[]) AND merchant_profile_id=$2 ORDER BY id FOR UPDATE`,
        [availabilityIds, input.merchantProfileId]);
      if (availabilities.rows.length !== availabilityIds.length) throw new Error('AVAILABILITY_NOT_FOUND');
      const lines = await client.query<{ id: string; quantity: number }>(
        `SELECT id, quantity FROM konektag.core_transaction_lines
         WHERE transaction_id=$1 AND merchant_profile_id=$2 ORDER BY id FOR UPDATE`,
        [input.transactionId, input.merchantProfileId]);
      const lineQuantities = new Map(lines.rows.map(line => [line.id, line.quantity]));
      const requestedByLine = new Map<string, number>();
      const requestedByAvailability = new Map<string, number>();
      for (const allocation of allocations) {
        if (!lineQuantities.has(allocation.transactionLineId)) throw new Error('LINE_NOT_FOUND');
        requestedByLine.set(allocation.transactionLineId,
          (requestedByLine.get(allocation.transactionLineId) ?? 0) + allocation.units);
        requestedByAvailability.set(allocation.availabilityId,
          (requestedByAvailability.get(allocation.availabilityId) ?? 0) + allocation.units);
      }
      const existing = await client.query<{ transaction_line_id: string; availability_id: string; units: number }>(
        `SELECT transaction_line_id, availability_id, units FROM konektag.core_allocations
         WHERE state='ACTIVE' AND (transaction_line_id=ANY($1::uuid[]) OR availability_id=ANY($2::uuid[]))`,
        [lines.rows.map(line => line.id), availabilityIds]);
      const usedByLine = new Map<string, number>();
      const usedByAvailability = new Map<string, number>();
      for (const allocation of existing.rows) {
        usedByLine.set(allocation.transaction_line_id, (usedByLine.get(allocation.transaction_line_id) ?? 0) + allocation.units);
        usedByAvailability.set(allocation.availability_id, (usedByAvailability.get(allocation.availability_id) ?? 0) + allocation.units);
      }
      for (const line of lines.rows) {
        const allocated = (usedByLine.get(line.id) ?? 0) + (requestedByLine.get(line.id) ?? 0);
        if (allocated > line.quantity) throw new Error('LINE_CAPACITY_EXCEEDED');
        if (allocated < line.quantity) throw new Error('ALLOCATION_INCOMPLETE');
      }
      for (const availability of availabilities.rows) {
        if ((usedByAvailability.get(availability.id) ?? 0) + (requestedByAvailability.get(availability.id) ?? 0)
            > availability.available_units) throw new Error('CAPACITY_EXCEEDED');
      }
      for (const allocation of allocations) {
        await client.query(`INSERT INTO konektag.core_allocations
          (merchant_profile_id, transaction_line_id, availability_id, units) VALUES ($1,$2,$3,$4)`,
          [input.merchantProfileId, allocation.transactionLineId, allocation.availabilityId, allocation.units]);
      }
    }
    await client.query(`UPDATE konektag.core_transactions SET state = $1, state_version = state_version + 1,
      updated_at = now() WHERE id = $2 AND merchant_profile_id = $3`, [next, input.transactionId, input.merchantProfileId]);
    if (input.command === 'CANCEL' || input.command === 'EXPIRE' || input.command === 'REJECT') {
      await client.query(`UPDATE konektag.core_allocations SET state = 'RELEASED'
        WHERE merchant_profile_id = $1 AND transaction_line_id IN
        (SELECT id FROM konektag.core_transaction_lines WHERE transaction_id = $2)`, [input.merchantProfileId, input.transactionId]);
    }
    await client.query(`INSERT INTO konektag.core_transition_journal
      (transaction_id, merchant_profile_id, actor_user_id, command_key, command, command_hash,
       from_state, to_state, from_version, to_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [input.transactionId, input.merchantProfileId,
      input.actorUserId, input.commandKey, input.command, commandHash, row.state, next, row.state_version, row.state_version + 1]);
    await notifyMerchantTransaction(client, { merchantProfileId: input.merchantProfileId, transactionId: input.transactionId, version: row.state_version + 1, state: next });
    await client.query('COMMIT');
    return { state: next, version: row.state_version + 1 };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export const coreContractVersion = CORE_CONTRACT_VERSION;
