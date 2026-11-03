import pool from '../../infrastructure/database/pool.ts';
import { minorDigits } from './pay/money-unit.ts';

/** Only accounting obligations enter this worker; it never calls a wallet/payment service. */
async function project(attributionId: string, refundId: string | null = null, cancel = false): Promise<void> {
  const db = await pool.connect();
  const lock = `merchant-accounting:${attributionId}`;
  try {
    await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [lock]);
    await db.query('BEGIN');
    const { rows: [a] } = await db.query('SELECT * FROM konektag.konektag_revenue_attributions WHERE id=$1 FOR UPDATE', [attributionId]);
    if (!a) throw new Error('ACCOUNTING_ATTRIBUTION_NOT_FOUND');
    let amount = a.amount_exact;
    if (refundId) {
      const {rows:[refund]} = await db.query(`SELECT r.bonus_reversal FROM konektag.points_merchant_refunds r
        JOIN konektag.points_merchant_consumptions c ON c.id=r.consumption_id
        WHERE r.id=$1 AND c.operation_key=$2 AND $3='merchant_bonus'`, [refundId,a.source_id,a.revenue_type]);
      if (!refund || Number(refund.bonus_reversal)<=0) throw new Error('ACCOUNTING_REFUND_SOURCE_MISMATCH');
      amount = refund.bonus_reversal;
    }
    const {rows:[legacyBonus]} = a.revenue_type==='merchant_bonus'
      ? await db.query(`SELECT b.legal_entity_id FROM konektag.merchant_points_bonuses b
          JOIN konektag.points_merchant_consumptions c ON c.id=b.consumption_id WHERE c.operation_key=$1`,[a.source_id])
      : {rows:[]};
    const {rows:[mapping]} = await db.query(`SELECT m.*,le.code AS entity_code,le.frappe_company
      FROM konektag.merchant_accounting_mappings m JOIN konektag.legal_entities le ON le.id=m.legal_entity_id
      WHERE m.merchant_profile_id=$1 AND m.revenue_type=$2 AND m.currency=$3
        AND (($4::uuid IS NOT NULL AND m.id=$4) OR ($4::uuid IS NULL AND m.active))
        AND ($5::uuid IS NULL OR m.legal_entity_id=$5)
        AND le.status='APPROVED' AND le.deleted_at IS NULL`,
      [a.merchant_profile_id,a.revenue_type,a.currency,a.mapping_id,a.legal_entity_id??legacyBonus?.legal_entity_id??null]);
    if (!mapping) throw new Error('ACCOUNTING_MAPPING_REQUIRED');
    if (!mapping.frappe_company) throw new Error('ACCOUNTING_COMPANY_MAPPING_REQUIRED');
    await db.query(`UPDATE konektag.konektag_revenue_attributions SET legal_entity_id=$2,mapping_id=$3,
      status=CASE WHEN projected_at IS NULL THEN 'PENDING_PROJECTION' ELSE status END WHERE id=$1`, [a.id,mapping.legal_entity_id,mapping.id]);
    const key = refundId ? `refund:${refundId}:${a.id}` : cancel ? `cancel:${a.id}` : `attribution:${a.id}`;
    await db.query(`INSERT INTO konektag.konektag_accounting_projections(attribution_id,refund_id,projection_key,amount_exact,is_reversal)
      VALUES($1,$2,$3,$4::numeric,$5) ON CONFLICT(projection_key) DO NOTHING`,[a.id,refundId,key,amount,!!refundId||cancel]);
    const {rows:[projection]} = await db.query(`SELECT *, (amount_exact / power(10::numeric,$2::int))::text AS amount_major
      FROM konektag.konektag_accounting_projections WHERE projection_key=$1`, [key,minorDigits(a.currency)]);
    await db.query('COMMIT'); // Freeze identity/mapping before a request that may lose its response.
    if (projection.projected_at) return;
    const base = process.env.ERPNEXT_URL?.replace(/\/$/,'');
    const secret = process.env.KONEKTAG_INTEGRATION_SECRET;
    if (!base || !secret) throw new Error('ACCOUNTING_INTEGRATION_CONFIG_REQUIRED');
    const response = await fetch(`${base}/api/method/konektag_integration.konektag_integration.accounting.post_obligation`, {
      method:'POST', headers:{'Content-Type':'application/json','X-Konektag-Integration-Secret':secret},
      signal:AbortSignal.timeout(30_000),
      body:JSON.stringify({obligation:{projection_id:projection.id,attribution_id:a.id,source_type:a.source_type,
        source_id:a.source_id,rule_id:a.rule_id,legal_entity:mapping.entity_code,company:mapping.frappe_company,
        currency:a.currency,amount:projection.amount_major,value_date:new Date(projection.created_at).toISOString().slice(0,10),
        debit_account:projection.is_reversal?mapping.credit_account:mapping.debit_account,
        credit_account:projection.is_reversal?mapping.debit_account:mapping.credit_account,cost_center:mapping.cost_center,
        reversal_of:projection.is_reversal?`attribution:${a.id}`:null}}),
    });
    if (!response.ok) throw new Error(`ACCOUNTING_PROJECTION_HTTP_${response.status}`);
    const receipt = (await response.json())?.message;
    if (!receipt || receipt.projection_id!==projection.id || receipt.docstatus!==1 || typeof receipt.voucher!=='string')
      throw new Error('ACCOUNTING_PROJECTION_RECEIPT_INVALID');
    await db.query('BEGIN');
    await db.query(`UPDATE konektag.konektag_accounting_projections SET voucher_reference=$2,projected_at=now()
      WHERE id=$1 AND projected_at IS NULL`, [projection.id,receipt.voucher]);
    if (!projection.is_reversal) {
      await db.query("UPDATE konektag.konektag_revenue_attributions SET status='PROJECTED',projected_at=COALESCE(projected_at,now()) WHERE id=$1",[a.id]);
      if (a.revenue_type==='merchant_bonus') await db.query(`UPDATE konektag.merchant_points_bonuses SET projection_status='projected'
        WHERE consumption_id=(SELECT id FROM konektag.points_merchant_consumptions WHERE operation_key=$1)`,[a.source_id]);
    } else {
      const {rows:[sum]}=await db.query(`SELECT COALESCE(sum(amount_exact),0) AS reversed FROM konektag.konektag_accounting_projections
        WHERE attribution_id=$1 AND is_reversal AND projected_at IS NOT NULL`,[a.id]);
      if (Number(sum.reversed)>=Number(a.amount_exact)) {
        await db.query("UPDATE konektag.konektag_revenue_attributions SET status='REVERSED',reversed_at=now() WHERE id=$1",[a.id]);
        await db.query(`UPDATE konektag.merchant_points_bonuses SET reversal_projection_status='projected'
          WHERE consumption_id=(SELECT id FROM konektag.points_merchant_consumptions WHERE operation_key=$1)`,[a.source_id]);
      }
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);
    db.release();
  }
}

async function bonusAttribution(consumptionId:string):Promise<string> {
  const {rows:[a]}=await pool.query(`SELECT a.id FROM konektag.konektag_revenue_attributions a
    JOIN konektag.points_merchant_consumptions c ON c.operation_key=a.source_id
    WHERE c.id=$1 AND a.source_type='merchant_consumption' AND a.revenue_type='merchant_bonus'`,[consumptionId]);
  if (!a) throw new Error('BONUS_ATTRIBUTION_REQUIRED');
  return a.id;
}
export const merchantAccountingProjectionService = {
  projectAttribution: (id:string) => project(id),
  async projectBonus(consumptionId:string) { await project(await bonusAttribution(consumptionId)); },
  async projectRefund(refundId:string) {
    const {rows:[refund]}=await pool.query('SELECT * FROM konektag.points_merchant_refunds WHERE id=$1',[refundId]);
    if (!refund) throw new Error('ACCOUNTING_REFUND_NOT_FOUND');
    if (Number(refund.bonus_reversal)>0) {
      const id=await bonusAttribution(refund.consumption_id);
      await project(id); // A reversal always uses the original frozen owner/accounts.
      await project(id,refundId);
    }
    await pool.query("UPDATE konektag.points_merchant_refunds SET projection_status='projected' WHERE id=$1",[refundId]);
    // Commission retention remains a separate, visible pending_rule decision.
  },
  async projectBonusCancellation(consumptionId:string) {
    const {rows:[source]}=await pool.query(`SELECT id FROM konektag.points_merchant_consumptions
      WHERE id=$1 AND status='cancelled'`,[consumptionId]);
    if (!source) throw new Error('BONUS_CANCELLATION_SOURCE_REQUIRED');
    const id=await bonusAttribution(consumptionId);await project(id);await project(id,null,true);
  },
};
