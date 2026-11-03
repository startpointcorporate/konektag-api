import pool from '../infrastructure/database/pool.ts';

export class ProInquiryService {
  async create(input: {
    businessName: string;
    email: string;
    phone?: string;
    country?: string;
    offerName?: string;
    message?: string;
    merchantProfileId?: string;
  }): Promise<{ id: string }> {
    const { rows } = await pool.query(
      `INSERT INTO konektag.pro_inquiries (business_name, email, phone, country, offer_name, message, merchant_profile_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.businessName, input.email, input.phone ?? null, input.country ?? null,
       input.offerName ?? 'Pro', input.message ?? null, input.merchantProfileId ?? null],
    );
    return { id: rows[0].id };
  }

  async list(status?: string): Promise<any[]> {
    const conditions = ['1=1'];
    const params: unknown[] = [];
    if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status); }
    const { rows } = await pool.query(
      `SELECT * FROM konektag.pro_inquiries WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params,
    );
    return rows;
  }

  async updateStatus(id: string, status: string): Promise<void> {
    await pool.query(`UPDATE konektag.pro_inquiries SET status = $1 WHERE id = $2`, [status, id]);
  }
}

export const proInquiryService = new ProInquiryService();
