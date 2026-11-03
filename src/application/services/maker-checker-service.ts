import pool from '../../infrastructure/database/pool.ts';
import type { PoolClient } from 'pg';

export interface MakerCheckerRecord {
  id: string;
  actionType: string;
  targetType: string;
  targetId: string;
  makerId: string;
  makerRole: string;
  checkerId: string | null;
  checkerRole: string | null;
  status: 'PREPARED' | 'APPROVED' | 'REJECTED';
  reason: string;
  payload: Record<string, unknown>;
  preparedAt: string;
  approvedAt: string | null;
}

export const makerCheckerService = {

  /** Enregistre une action preparee par un maker. */
  async recordPreparation(params: {
    actionType: string;
    targetType: string;
    targetId: string;
    makerId: string;
    makerRole: string;
    reason: string;
    payload?: Record<string, unknown>;
  }, client?: PoolClient): Promise<string> {
    const c = client || pool;
    const { rows: [rec] } = await c.query(
      `INSERT INTO konektag.admin_actions (admin_id, action_type, target_type, target_id, reason, payload)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [params.makerId, `MAKER_${params.actionType}`, params.targetType, params.targetId,
       `[MAKER:${params.makerRole}] ${params.reason}`,
       JSON.stringify({ ...params.payload, makerId: params.makerId, makerRole: params.makerRole, step: 'prepared' })],
    );
    return rec.id;
  },

  /** Approuve une action — verifie que l'approbateur est different du maker. */
  async recordApproval(params: {
    actionType: string;
    targetType: string;
    targetId: string;
    checkerId: string;
    checkerRole: string;
    reason: string;
    payload?: Record<string, unknown>;
  }, client?: PoolClient): Promise<{ ok: boolean; error?: string }> {
    const c = client || pool;

    // Verifier que le maker est different du checker
    const { rows: [prepared] } = await c.query(
      `SELECT admin_id, payload FROM konektag.admin_actions
       WHERE target_type = $1 AND target_id = $2
         AND action_type = $3
       ORDER BY created_at DESC LIMIT 1`,
      [params.targetType, params.targetId, `MAKER_${params.actionType}`],
    );

    if (!prepared) {
      return { ok: false, error: 'Aucune preparation trouvee pour cette action.' };
    }

    try {
      const makerPayload = typeof prepared.payload === 'string'
        ? JSON.parse(prepared.payload) : prepared.payload;
      const makerId = makerPayload?.makerId;

      if (makerId === params.checkerId) {
        return { ok: false, error: 'MAKER_CHECKER_VIOLATION: Le prepareur ne peut pas approuver sa propre action.' };
      }
    } catch {}

    // Enregistrer l'approbation
    await c.query(
      `INSERT INTO konektag.admin_actions (admin_id, action_type, target_type, target_id, reason, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [params.checkerId, `CHECKER_${params.actionType}`, params.targetType, params.targetId,
       `[CHECKER:${params.checkerRole}] ${params.reason}`,
       JSON.stringify({ ...params.payload, checkerId: params.checkerId, checkerRole: params.checkerRole, step: 'approved' })],
    );

    return { ok: true };
  },

  /** Verifie si le maker-checker est requis pour ce type d'action. */
  requiresMakerChecker(actionType: string): boolean {
    const MAKER_CHECKER_ACTIONS = [
      'RECHARGE_CONFIRM', 'RECHARGE_REFUND', 'KYC_APPROVE', 'KYC_REJECT',
      'USER_BAN', 'USER_UNBAN', 'MERCHANT_SETTLEMENT_CONFIRM',
      'MERCHANT_CERTIFY', 'MERCHANT_CLAIM_APPROVE', 'MERCHANT_CLAIM_REJECT',
      'CARD_BATCH_CREATE', 'COMMISSION_RATE_CHANGE', 'CAMPAIGN_ACTION',
    ];
    return MAKER_CHECKER_ACTIONS.includes(actionType);
  },
};
