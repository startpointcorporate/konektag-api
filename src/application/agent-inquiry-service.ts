import pool from '../infrastructure/database/pool.ts';

export class AgentInquiryService {
  async create(input: {
    businessName: string;
    email: string;
    phone?: string;
    country?: string;
    message?: string;
    motivation?: string;
    merchantProfileId?: string;
  }): Promise<{ id: string }> {
    const { rows } = await pool.query(
      `INSERT INTO konektag.agent_inquiries (business_name, email, phone, country, message, motivation, merchant_profile_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.businessName, input.email, input.phone ?? null, input.country ?? null, input.message ?? null, input.motivation ?? input.message ?? null, input.merchantProfileId ?? null],
    );
    return { id: rows[0].id };
  }

  async list(status?: string): Promise<any[]> {
    const conditions = ['1=1'];
    const params: unknown[] = [];
    if (status) { conditions.push(`ai.status = $${params.length + 1}`); params.push(status); }
    const { rows } = await pool.query(
      `SELECT ai.*, mp.business_name as merchant_business_name
       FROM konektag.agent_inquiries ai
       LEFT JOIN konektag.merchant_profiles mp ON mp.id = ai.merchant_profile_id AND mp.deleted_at IS NULL
       WHERE ${conditions.join(' AND ')}
       ORDER BY ai.created_at DESC`,
      params,
    );
    return rows;
  }

  async updateStatus(id: string, status: string, reviewerId?: string): Promise<void> {
    if (reviewerId) {
      await pool.query(
        `UPDATE konektag.agent_inquiries SET status = $1, reviewed_by = $2, reviewed_at = now() WHERE id = $3`,
        [status, reviewerId, id],
      );
    } else {
      await pool.query(`UPDATE konektag.agent_inquiries SET status = $1 WHERE id = $2`, [status, id]);
    }
  }

  async activateAgentFromInquiry(inquiryId: string, reviewerId: string): Promise<{ success: boolean; message: string }> {
    const { rows: [inq] } = await pool.query(`SELECT * FROM konektag.agent_inquiries WHERE id = $1`, [inquiryId]);
    if (!inq) return { success: false, message: 'Candidature introuvable.' };
    if (inq.status !== 'approved') return { success: false, message: 'La candidature doit d\'abord être approuvée (statut actuel : ' + inq.status + ').' };

    if (!inq.merchant_profile_id) {
      return { success: false, message: 'Aucun profil commerçant n\'est associé à cette candidature. L\'activation doit être faite depuis la page Agents si le commerçant existe.' };
    }

    const { rows: [mp] } = await pool.query(
      `SELECT id, status, agent_enabled FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`,
      [inq.merchant_profile_id],
    );
    if (!mp) return { success: false, message: 'Le profil commerçant associé n\'existe plus.' };
    if (mp.status !== 'Published') return { success: false, message: 'Le profil commerçant n\'est pas publié (statut : ' + mp.status + ').' };
    if (mp.agent_enabled) return { success: false, message: 'Ce commerçant est déjà Agent.' };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE konektag.merchant_profiles SET agent_enabled = true, version = version + 1 WHERE id = $1 AND deleted_at IS NULL`,
        [inq.merchant_profile_id],
      );
      await client.query(
        `INSERT INTO konektag.ambassador_profiles
         (user_id, merchant_profile_id, display_name, email, phone, ambassador_type,
          country, city, status, max_active_missions, commission_rate)
         SELECT COALESCE($2::uuid, mp.user_id), mp.id, mp.business_name, mp.email, mp.phone, 'Agent',
                mp.country, mp.city, 'Actif', 0, COALESCE(r.commission_rate, 1)
         FROM konektag.merchant_profiles mp
         LEFT JOIN LATERAL (
           SELECT commission_rate FROM konektag.agent_commission_rates
           WHERE merchant_profile_id = mp.id AND is_active = true ORDER BY updated_at DESC LIMIT 1
         ) r ON true
         WHERE mp.id = $1
         ON CONFLICT (user_id) DO UPDATE SET
           merchant_profile_id = EXCLUDED.merchant_profile_id,
           ambassador_type = CASE WHEN konektag.ambassador_profiles.ambassador_type = 'Representative' THEN 'Both' ELSE 'Agent' END,
           display_name = EXCLUDED.display_name, email = EXCLUDED.email, phone = EXCLUDED.phone,
           country = EXCLUDED.country, city = EXCLUDED.city, status = 'Actif', updated_at = now()`,
         [inq.merchant_profile_id, inq.owner_user_id ?? null],
      );
      await client.query(
        `UPDATE konektag.agent_inquiries SET reviewed_by = $1, reviewed_at = now() WHERE id = $2`,
        [reviewerId, inquiryId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return { success: true, message: 'Agent activé — le commerçant peut maintenant vendre des Cartes K.' };
  }
}

export const agentInquiryService = new AgentInquiryService();
