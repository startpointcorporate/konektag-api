import type { PoolClient } from 'pg';
import pool from '../database/pool.ts';
import type { ApplyForAgentInput, MissionSearchFilters, RegisterRepresentativeInput, SubmitMissionInput } from '../../domain/Ambassador.ts';

const missionSelect = `
  SELECT m.*, m.id::text AS name, m.representative_id::text AS representative,
         COALESCE(json_agg(json_build_object(
           'name', e.id::text, 'evidence_type', e.evidence_type,
           'file_url', e.file_url, 'comment', e.comment
         ) ORDER BY e.created_at) FILTER (WHERE e.id IS NOT NULL), '[]') AS evidence
  FROM konektag.field_missions m
  LEFT JOIN konektag.mission_evidence e ON e.mission_id = m.id`;

const availableMissionSelect = `
  SELECT m.*, 'Available'::text AS status, m.id::text AS name, m.representative_id::text AS representative,
         '[]'::json AS evidence
  FROM konektag.field_missions m`;

export class AmbassadorRepository {
  async createAgentApplication(userId: string, input: ApplyForAgentInput) {
    const params = input.merchant_profile_id ? [userId, input.merchant_profile_id] : [userId];
    const requestedProfile = input.merchant_profile_id ? 'AND mp.id = $2' : '';
    const { rows: [merchant] } = await pool.query(
      `SELECT mp.id FROM konektag.merchant_profiles mp
       LEFT JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id = mp.id
          AND mm.user_id = $1 AND mm.status = 'active' AND mm.role IN ('owner', 'manager')
       WHERE mp.deleted_at IS NULL AND (mp.user_id = $1 OR mm.user_id IS NOT NULL)
         ${requestedProfile}
       ORDER BY COALESCE(mm.is_primary, false) DESC, mp.created_at DESC LIMIT 1`,
      params,
    );
    if (!merchant) throw new Error('FORBIDDEN_MERCHANT');

    const { rows: [row] } = await pool.query(
      `INSERT INTO konektag.agent_inquiries
       (owner_user_id, merchant_profile_id, business_name, manager_name, phone, email,
        country, city, full_address, activity_type, estimated_client_volume,
        available_space, opening_hours, justificatif_file, message, motivation,
        terms_accepted, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,'pending',now())
       RETURNING *`,
      [userId, merchant.id, input.business_name, input.manager_name,
       input.phone, input.email, input.country, input.city, input.full_address || null,
       input.activity_type, input.estimated_client_volume || 0, input.available_space || null,
       input.opening_hours || null, input.justificatif_file || null, input.comment || null,
       input.terms_accepted],
    );
    return row;
  }

  async getAgentApplication(userId: string, merchantProfileId: string) {
    const { rows: [row] } = await pool.query(
      `SELECT ai.* FROM konektag.agent_inquiries ai
       WHERE ai.owner_user_id = $1 AND ai.merchant_profile_id = $2
       ORDER BY ai.created_at DESC LIMIT 1`,
      [userId, merchantProfileId],
    );
    return row ?? null;
  }

  async listAgents(filters: { country?: string; city?: string; area?: string; limit?: number; offset?: number }) {
    const conditions = [`ap.status = 'Actif'`, `ap.ambassador_type IN ('Agent','Both')`, `mp.agent_enabled = true`, `mp.deleted_at IS NULL`];
    const params: unknown[] = [];
    for (const [column, value] of [['country', filters.country], ['city', filters.city], ['area', filters.area]] as const) {
      if (value) { params.push(value); conditions.push(`ap.${column} = $${params.length}`); }
    }
    params.push(Math.min(filters.limit || 50, 100), Math.max(filters.offset || 0, 0));
    const { rows } = await pool.query(
      `SELECT ap.*, ap.id::text AS name, ap.display_name AS ambassadeur_name,
              ap.user_id::text AS app_user_id
       FROM konektag.ambassador_profiles ap
       JOIN konektag.merchant_profiles mp ON mp.id = ap.merchant_profile_id
       WHERE ${conditions.join(' AND ')} ORDER BY ap.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows;
  }

  async getAgent(id: string) {
    const { rows: [row] } = await pool.query(
      `SELECT ap.*, ap.id::text AS name, ap.display_name AS ambassadeur_name,
              ap.user_id::text AS app_user_id
       FROM konektag.ambassador_profiles ap
       JOIN konektag.merchant_profiles mp ON mp.id = ap.merchant_profile_id
       WHERE ap.id = $1 AND ap.status = 'Actif' AND ap.ambassador_type IN ('Agent','Both')
         AND mp.agent_enabled = true AND mp.deleted_at IS NULL`, [id]);
    return row ?? null;
  }

  async getOwnedAgent(userId: string, ambassadorId: string) {
    const { rows: [row] } = await pool.query(
      `SELECT id FROM konektag.ambassador_profiles
       WHERE id = $1 AND user_id = $2 AND ambassador_type IN ('Agent','Both') AND status = 'Actif'`,
      [ambassadorId, userId]);
    return row ?? null;
  }

  async registerRepresentative(userId: string, input: RegisterRepresentativeInput) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO konektag.ambassador_profiles
       (user_id, display_name, ambassador_type, country, city, area, max_active_missions)
       VALUES ($1, 'Rep-' || left($1::text, 8), 'Representative', $2, $3, $4, 3)
       ON CONFLICT (user_id) DO UPDATE SET
         ambassador_type = CASE WHEN konektag.ambassador_profiles.ambassador_type = 'Agent' THEN 'Both' ELSE konektag.ambassador_profiles.ambassador_type END,
         country = EXCLUDED.country, city = EXCLUDED.city, area = EXCLUDED.area, updated_at = now()
       RETURNING *, id::text AS name, display_name AS ambassadeur_name, user_id::text AS app_user_id`,
      [userId, input.country, input.city, input.area || null]);
    return row;
  }

  async getProfileByUser(userId: string) {
    const { rows: [row] } = await pool.query(
      `SELECT *, id::text AS name, display_name AS ambassadeur_name, user_id::text AS app_user_id
       FROM konektag.ambassador_profiles WHERE user_id = $1 AND status = 'Actif'`, [userId]);
    return row ?? null;
  }

  async listAvailableMissions(filters: MissionSearchFilters) {
    const conditions = [`(m.status = 'Available' OR (m.status = 'Reserved' AND m.reservation_expires_at <= now()))`];
    const params: unknown[] = [];
    for (const [column, value] of [['country', filters.country], ['city', filters.city], ['mission_type', filters.mission_type], ['activity_type', filters.activity_type], ['priority', filters.priority]] as const) {
      if (value) { params.push(value); conditions.push(`m.${column} = $${params.length}`); }
    }
    params.push(Math.min(filters.limit || 50, 100), Math.max(filters.offset || 0, 0));
    const { rows } = await pool.query(
       `${availableMissionSelect} WHERE ${conditions.join(' AND ')}
        ORDER BY m.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return rows;
  }

  async getMission(id: string, userId: string) {
    const { rows: [row] } = await pool.query(
       `${missionSelect}
        WHERE m.id = $1 AND (m.status = 'Available' OR EXISTS (
          SELECT 1 FROM konektag.ambassador_profiles ap
          WHERE ap.id = m.representative_id AND ap.user_id = $2))
       GROUP BY m.id`, [id, userId]);
    return row ?? null;
  }

  async reserveMission(id: string, userId: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [profile] } = await client.query(
        `SELECT id, max_active_missions FROM konektag.ambassador_profiles
         WHERE user_id = $1 AND status = 'Actif' AND ambassador_type IN ('Representative','Both') FOR UPDATE`, [userId]);
      if (!profile) throw new Error('NOT_AMBASSADOR');
      const { rows: [count] } = await client.query(
         `SELECT count(*)::int AS value FROM konektag.field_missions
          WHERE representative_id = $1
            AND (status = 'InProgress' OR (status = 'Reserved' AND (reservation_expires_at IS NULL OR reservation_expires_at > now())))`,
        [profile.id]);
      if (count.value >= profile.max_active_missions) throw new Error('MISSION_LIMIT_REACHED');
      const { rows: [mission] } = await client.query(
        `UPDATE konektag.field_missions SET status = 'Reserved', representative_id = $1,
           reserved_at = now(), reservation_expires_at = now() + deadline_hours * interval '1 hour', updated_at = now()
          WHERE id = $2 AND (status = 'Available' OR (status = 'Reserved' AND reservation_expires_at <= now()))
          RETURNING id`, [profile.id, id]);
      if (!mission) throw new Error('MISSION_NOT_AVAILABLE');
      await client.query('COMMIT');
      return this.getMission(id, userId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async submitMission(id: string, userId: string, input: SubmitMissionInput) {
    if (!input.evidence.length || input.evidence.some(e => !e.file_url?.trim() && !e.comment?.trim())) {
      throw new Error('INVALID_EVIDENCE');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [mission] } = await client.query(
        `SELECT m.id FROM konektag.field_missions m
         JOIN konektag.ambassador_profiles ap ON ap.id = m.representative_id
         WHERE m.id = $1 AND ap.user_id = $2 AND m.status IN ('Reserved','InProgress') FOR UPDATE`, [id, userId]);
      if (!mission) throw new Error('FORBIDDEN_MISSION');
      for (const evidence of input.evidence) {
        await client.query(
          `INSERT INTO konektag.mission_evidence (mission_id, evidence_type, file_url, comment, submitted_by)
           VALUES ($1,$2,$3,$4,$5)`,
           [id, evidence.evidence_type, evidence.file_url?.trim() || '', evidence.comment?.trim() || '', userId]);
      }
      await client.query(
        `UPDATE konektag.field_missions SET status = 'Submitted', submitted_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await client.query('COMMIT');
      return this.getMission(id, userId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async listMyMissions(userId: string) {
    const { rows } = await pool.query(
      `${missionSelect} JOIN konektag.ambassador_profiles ap ON ap.id = m.representative_id
       WHERE ap.user_id = $1 GROUP BY m.id ORDER BY m.created_at DESC LIMIT 100`, [userId]);
    return rows;
  }

  async listCommissions(userId: string, ambassadorId?: string, commissionType?: 'RepresentativeMission' | 'AgentWithdrawal') {
    const params: unknown[] = [userId];
    let requested = '';
    if (ambassadorId) { params.push(ambassadorId); requested = ' AND ap.id = $2'; }
    if (commissionType) { params.push(commissionType); requested += ` AND c.commission_type = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT c.*, c.id::text AS name, c.ambassador_id::text AS ambassadeur,
              c.mission_id::text AS mission, c.withdrawal_ref AS withdrawal
       FROM konektag.ambassador_commissions c
       JOIN konektag.ambassador_profiles ap ON ap.id = c.ambassador_id
       WHERE ap.user_id = $1${requested} ORDER BY c.created_at DESC LIMIT 100`, params);
    return rows;
  }
}

export const ambassadorRepository = new AmbassadorRepository();
