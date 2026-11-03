import pool from '../../infrastructure/database/pool.ts';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { FinancialOperationService } from './financial-operation-service.ts';

function hashPin(pin: string): string {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

function generatePin(): string {
  return crypto.randomInt(100000, 999999).toString();
}

export interface CardBatch {
  id: string; seriesStart: string; size: number; amount: number; createdAt: string;
}

export interface CardRecord {
  id: string; number: string; amount: number; status: 'GENERATED' | 'DISTRIBUTED' | 'SOLD' | 'ACTIVATED' | 'CANCELLED' | 'BLOCKED';
  batchId: string; soldAt: string | null; soldBy: string | null; redeemedAt: string | null; qrCode: string | null;
}

export interface MerchantCardReport {
  merchantId: string; merchantName: string; totalSold: number; totalValue: number;
  totalActivated: number; soldNotActivated: number;
}

export interface MerchantCardDetail {
  soldAt: string; cardNumber: string; amount: number; status: string; activatedAt: string | null;
}

export const cardBatchService = {
  async createBatch(size: number, amount: number, adminUserId: string, countryCode = 'FR'): Promise<{ batchId: string; csv: string }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [lastCard] } = await client.query(`SELECT number FROM konektag.cards ORDER BY number DESC LIMIT 1`);
      const lastNumber = lastCard ? BigInt(lastCard.number) : BigInt('1000000000000000');
      const seriesStart = (lastNumber + BigInt(1)).toString();

      const { rows: [entity] } = await client.query(
        `SELECT id FROM konektag.legal_entities WHERE country_code=$1 AND status='APPROVED' AND deleted_at IS NULL ORDER BY code LIMIT 1`, [countryCode],
      );
      if (!entity) throw new Error('CARD_LEGAL_ENTITY_NOT_CONFIGURED');
      const { rows: [batch] } = await client.query(
        `INSERT INTO konektag.card_batches (series_start, size, amount, created_by, legal_entity_id, country_code, lifecycle_status) VALUES ($1,$2,$3,$4,$5,$6,'MANUFACTURED') RETURNING id`,
        [seriesStart, size, amount, adminUserId, entity.id, countryCode],
      );
      const batchId = batch.id;

      const lines: string[] = ['number;pin;amount'];
      const seenPins = new Set<string>();
      for (let i = 0; i < size; i++) {
        const number = (BigInt(seriesStart) + BigInt(i)).toString().padStart(16, '0');
        let pin: string;
        do { pin = generatePin(); } while (seenPins.has(pin));
        seenPins.add(pin);
        const pinHash = hashPin(pin);
        const qrCode = getCardQrDataUrl(number);
        await client.query(
          `INSERT INTO konektag.cards (number, pin, amount, batch_id, qr_code, legal_entity_id, country_code) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [number, pinHash, amount, batchId, qrCode, entity.id, countryCode],
        );
        lines.push(`${number};${pin};${amount}`);
      }

      await client.query('COMMIT');
      return { batchId, csv: lines.join('\n') };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async listBatches(limit = 20, offset = 0): Promise<{ batches: any[]; total: number }> {
    const { rows: [{ count }] } = await pool.query(`SELECT COUNT(*) as count FROM konektag.card_batches`);
    const { rows } = await pool.query(
      `SELECT cb.*,
        (SELECT COUNT(*) FROM konektag.cards WHERE batch_id = cb.id AND status = 'GENERATED' AND deleted_at IS NULL) as generated_count,
        (SELECT COUNT(*) FROM konektag.cards WHERE batch_id = cb.id AND status = 'SOLD' AND deleted_at IS NULL) as sold_count,
        (SELECT COUNT(*) FROM konektag.cards WHERE batch_id = cb.id AND status = 'ACTIVATED' AND deleted_at IS NULL) as activated_count
       FROM konektag.card_batches cb ORDER BY cb.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return { batches: rows, total: parseInt(count, 10) };
  },

  async isAgent(userId: string): Promise<boolean> {
    const { rows: [row] } = await pool.query(
      `SELECT mp.agent_enabled, mp.status as mp_status, u.state
       FROM konektag.merchant_profiles mp
       JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id = mp.id
         AND mm.user_id = $1 AND mm.status = 'active'
       JOIN konektag.users u ON u.id = $1 AND u.deleted_at IS NULL
       WHERE mp.deleted_at IS NULL AND mp.status = 'Published'
       ORDER BY mm.is_primary DESC, mp.created_at DESC
       LIMIT 1`,
      [userId],
    );
    if (!row) return false;
    if (row.state === 'BANNED') return false;
    return row.agent_enabled === true;
  },

  async getMerchantAgentProfile(userId: string): Promise<{ merchantProfileId: string; businessName: string } | null> {
    const { rows: [row] } = await pool.query(
      `SELECT mp.id, mp.business_name, mp.agent_enabled
       FROM konektag.merchant_profiles mp
       JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id = mp.id
         AND mm.user_id = $1 AND mm.status = 'active'
       WHERE mp.deleted_at IS NULL AND mp.status = 'Published'
       ORDER BY mm.is_primary DESC, mp.created_at DESC
       LIMIT 1`,
      [userId],
    );
    if (!row) return null;
    return { merchantProfileId: row.id, businessName: row.business_name };
  },

  async getCardByNumber(cleanNumber: string): Promise<any> {
    const { rows: [card] } = await pool.query(
       `SELECT id, number, amount, status, version, pin, qr_code, sold_by, sold_at, batch_id, created_at, redeemed_at, redeemed_by, legal_entity_id, country_code
       FROM konektag.cards WHERE number = $1 AND deleted_at IS NULL`,
      [cleanNumber],
    );
    return card || null;
  },

  async sellCardByScan(number: string, merchantUserId: string): Promise<{ success: boolean; amount: number; message: string; card?: any }> {
    const cleanNumber = number.replace(/\s/g, '');

    if (!await this.isAgent(merchantUserId)) {
      return { success: false, amount: 0, message: 'Seul un commerçant partenaire disposant de la capacité Agent peut vendre une Carte K.' };
    }
    const card = await this.getCardByNumber(cleanNumber);
    if (!card) return { success: false, amount: 0, message: 'Carte K introuvable.' };
    if (card.status === 'SOLD') return { success: false, amount: 0, message: 'Cette Carte K a déjà été vendue.' };
    if (card.status === 'ACTIVATED') return { success: false, amount: 0, message: 'Cette Carte K a déjà été activée.' };
    if (card.status !== 'DISTRIBUTED') return { success: false, amount: 0, message: 'Cette Carte K doit etre distribuee avant sa vente.' };

    const { rowCount } = await pool.query(
      `UPDATE konektag.cards SET status = 'SOLD', sold_at = now(), sold_by = $1, version = version + 1 WHERE id = $2 AND version = $3`,
      [merchantUserId, card.id, card.version],
    );
    if (rowCount === 0) return { success: false, amount: 0, message: 'Conflit, veuillez réessayer.' };

    await pool.query(
      `INSERT INTO konektag.card_audit_log (card_id, action, user_id) VALUES ($1,'SELL',$2)`,
      [card.id, merchantUserId],
    );

    return { success: true, amount: card.amount, message: `Carte K enregistrée comme vendue — ${card.amount} K`, card: { ...card, status: 'SOLD' } };
  },

  async sellCard(number: string, pin: string, merchantUserId: string): Promise<{ success: boolean; amount: number; message: string }> {
    const cleanNumber = number.replace(/\s/g, '');

    if (!await this.isAgent(merchantUserId)) {
      return { success: false, amount: 0, message: 'Seul un commerçant partenaire disposant de la capacité Agent peut vendre une Carte K.' };
    }
    const card = await this.getCardByNumber(cleanNumber);
    if (!card) return { success: false, amount: 0, message: 'Carte K introuvable.' };
    if (card.status === 'SOLD') return { success: false, amount: 0, message: 'Cette Carte K a déjà été vendue.' };
    if (card.status === 'ACTIVATED') return { success: false, amount: 0, message: 'Cette Carte K a déjà été activée.' };
    if (card.status !== 'DISTRIBUTED') return { success: false, amount: 0, message: 'Cette Carte K doit etre distribuee avant sa vente.' };
    if (card.pin !== hashPin(pin)) return { success: false, amount: 0, message: 'PIN incorrect.' };

    const { rowCount } = await pool.query(
      `UPDATE konektag.cards SET status = 'SOLD', sold_at = now(), sold_by = $1, version = version + 1 WHERE id = $2 AND version = $3`,
      [merchantUserId, card.id, card.version],
    );
    if (rowCount === 0) return { success: false, amount: 0, message: 'Conflit, veuillez réessayer.' };

    await pool.query(
      `INSERT INTO konektag.card_audit_log (card_id, action, user_id) VALUES ($1,'SELL',$2)`,
      [card.id, merchantUserId],
    );

    return { success: true, amount: card.amount, message: `Carte K enregistrée comme vendue — ${card.amount} K` };
  },

  async redeemCard(number: string, pin: string, userId: string, keycloakId: string, ip: string, ua: string): Promise<{ success: boolean; amount: number; message: string }> {
    const cleanNumber = number.replace(/\s/g, '');
    const pinHash = hashPin(pin);

    const card = await this.getCardByNumber(cleanNumber);
    if (!card) return { success: false, amount: 0, message: 'Carte K introuvable.' };
    if (card.status === 'GENERATED' || card.status === 'DISTRIBUTED') return { success: false, amount: 0, message: 'Cette Carte K n\'a pas encore été validée comme vendue par un commerçant partenaire Konektag.' };
    if (card.status === 'ACTIVATED') return { success: true, amount: card.amount, message: `+${card.amount} credits K deja actives.` };
    if (card.status !== 'SOLD') return { success: false, amount: 0, message: 'Cette Carte K ne peut pas être activée.' };
    if (card.pin !== pinHash) return { success: false, amount: 0, message: 'PIN incorrect.' };

    const { rows: [batch] } = await pool.query(
      `SELECT created_at FROM konektag.card_batches WHERE id = $1`, [card.batchId],
    );
    if (batch) {
      const batchAge = (Date.now() - new Date(batch.created_at).getTime()) / (1000 * 3600 * 24);
      if (batchAge > 365) return { success: false, amount: 0, message: 'Cette Carte K a expire (lot de plus d\'un an).' };
    }

    const { rows: [user] } = await pool.query(
      `SELECT state FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`, [userId],
    );
    if (!user || user.state !== 'COMPLETED') return { success: false, amount: 0, message: 'Votre compte doit être vérifié (KYC complété) pour activer une Carte K.' };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [cardEntity] } = await client.query(
        `SELECT id, country_code, base_currency FROM konektag.legal_entities WHERE id = COALESCE($1::uuid, id) AND code = COALESCE(NULLIF($2, ''), code) AND status = 'APPROVED' AND deleted_at IS NULL LIMIT 1`,
        [card.legal_entity_id ?? null, card.country_code === 'CG' ? 'KTG-CG' : 'KTG-FR'],
      );
      const { rows: cardProfiles } = await client.query(
        `SELECT id, rail FROM konektag.regulatory_profiles
         WHERE legal_entity_id = $1 AND country_of_origin = $2 AND country_of_destination = $2
           AND authorized_operation = 'acquisition' AND status = 'APPROVED' AND deleted_at IS NULL
           AND metadata->>'purpose' = 'P04_CARD_ACTIVATION' LIMIT 2`,
        [cardEntity?.id, cardEntity?.country_code],
      );
      const cardProfile = cardProfiles[0];
      const cardEntityId = cardEntity?.id;
      const cardProfileId = cardProfile?.id;
      if (!cardEntityId || cardProfiles.length !== 1 || !cardProfileId || cardProfile.rail !== 'internal') {
        throw new Error('CARD_PROFILE_RAIL_NOT_CONFIGURED');
      }
      const { rows: [confirmation] } = await client.query(
        `SELECT csd.id, csd.declaration_ref FROM konektag.card_sale_declarations csd
         JOIN konektag.card_sale_declaration_cards csdc ON csdc.declaration_id = csd.id
         WHERE csdc.card_id = $1 AND csd.status = 'APPROVED'
           AND NULLIF(BTRIM(csd.evidence_url), '') IS NOT NULL FOR UPDATE`, [card.id],
      );
      if (!confirmation) throw new Error('CARD_VOUCHER_CONFIRMATION_REQUIRED');
      const { rows: [klot] } = await client.query(
        `INSERT INTO konektag.klots (klot_ref, origin_entity_id, origin_country, rail, rail_ref, issuer, quantity_k, remaining_quantity, economic_currency, economic_value, regulatory_profile_id, status)
         VALUES ($1,$2,$3,'internal',$4,'Konektag',$5,$6,'XOF',$7,$8,'VALUATED') ON CONFLICT (klot_ref) DO UPDATE SET status='VALUATED' RETURNING id`,
        [`KLOT-CARD-${cleanNumber}`, cardEntityId, cardEntity.country_code, confirmation.declaration_ref, card.amount, card.amount, card.amount, cardProfileId],
      );
      const operation = await new FinancialOperationService(client, false).execute({
        idempotencyKey: `CARD-${cleanNumber}-${card.id.slice(0, 8)}`,
        operationId: `CARD-ACTIVATE-${cleanNumber}`,
        operation: 'acquisition',
        legalEntityId: cardEntityId,
        userId,
        keycloakId,
        countryOfOrigin: cardEntity.country_code,
        countryOfDestination: cardEntity.country_code,
        amount: card.amount,
        rail: cardProfile.rail,
        corridorId: `${cardEntity.country_code}-${cardEntity.country_code}`,
        regulatoryProfileId: cardProfileId,
        currency: cardEntity.base_currency,
        klotId: klot.id,
        klotQuantity: card.amount,
        entries: [
          { clientId: keycloakId, accountCode: '1000', side: 'credit', amount: card.amount, description: `Activation Carte K — ${cleanNumber}` },
          { clientId: keycloakId, accountCode: '7000', side: 'debit', amount: card.amount, description: `Clearing Carte K — ${cleanNumber}` },
        ],
      });
      if (!operation.success) throw new Error(operation.error || 'CARD_USER_GL_FAILED');
      const { rowCount } = await client.query(
        `UPDATE konektag.cards SET status='ACTIVATED', redeemed_at=now(), redeemed_by=$1, financial_transaction_id=$2, version=version+1 WHERE id=$3 AND version=$4 AND status='SOLD'`,
        [userId, operation.financialTransactionId, card.id, card.version],
      );
      if (!rowCount) throw new Error('CARD_ACTIVATION_CONFLICT');
      await client.query(`INSERT INTO konektag.card_audit_log (card_id, action, user_id, ip_address, user_agent) VALUES ($1,'ACTIVATE',$2,$3,$4)`, [card.id, userId, ip, ua]);
      await client.query('COMMIT');
      return { success: true, amount: card.amount, message: `+${card.amount} credits K ajoutes a votre portefeuille.` };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async getMerchantReport(merchantUserId?: string, dateFrom?: string, dateTo?: string): Promise<{
    report: MerchantCardReport[]; details: MerchantCardDetail[]; totalSold: number; totalValue: number;
  }> {
    const params: any[] = [];
    const conditions: string[] = ['c.sold_by IS NOT NULL', 'c.deleted_at IS NULL'];
    let paramIdx = 1;

    if (merchantUserId) {
      conditions.push(`c.sold_by = $${paramIdx++}`);
      params.push(merchantUserId);
    }
    if (dateFrom) {
      conditions.push(`c.sold_at >= $${paramIdx++}`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`c.sold_at <= $${paramIdx++}`);
      params.push(dateTo);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: reportRows } = await pool.query(
      `SELECT c.sold_by as merchant_id,
         COUNT(*)::int as total_sold,
         SUM(c.amount)::int as total_value,
         COUNT(CASE WHEN c.status = 'ACTIVATED' THEN 1 END)::int as total_activated,
         COUNT(CASE WHEN c.status = 'SOLD' THEN 1 END)::int as sold_not_activated
       FROM konektag.cards c
       ${where}
       GROUP BY c.sold_by
       ORDER BY total_sold DESC`,
      params,
    );

    const { rows: detailRows } = await pool.query(
      `SELECT c.sold_at, c.number as card_number, c.amount, c.status, c.redeemed_at as activated_at
       FROM konektag.cards c
       ${where}
       ORDER BY c.sold_at DESC
       LIMIT 500`,
      params,
    );

    const totalResult = await pool.query(
      `SELECT COUNT(*)::int as total_sold, COALESCE(SUM(c.amount), 0)::int as total_value
       FROM konektag.cards c ${where}`,
      params,
    );

    return {
      report: reportRows.map((r: any) => ({
        merchantId: r.merchant_id,
        merchantName: '',
        totalSold: r.total_sold,
        totalValue: r.total_value,
        totalActivated: r.total_activated,
        soldNotActivated: r.sold_not_activated,
      })),
      details: detailRows.map((d: any) => ({
        soldAt: d.sold_at,
        cardNumber: d.card_number,
        amount: d.amount,
        status: d.status,
        activatedAt: d.activated_at,
      })),
      totalSold: parseInt(totalResult.rows[0]?.total_sold ?? '0', 10),
      totalValue: parseInt(totalResult.rows[0]?.total_value ?? '0', 10),
    };
  },

  async getCardQrData(number: string): Promise<{ success: boolean; qrCode?: string; message?: string }> {
    const cleanNumber = number.replace(/\s/g, '');
    const card = await this.getCardByNumber(cleanNumber);
    if (!card) return { success: false, message: 'Carte K introuvable.' };
    return { success: true, qrCode: card.qr_code };
  },

  async toggleAgentCapability(merchantProfileId: string, enabled: boolean, adminUserId: string): Promise<{ success: boolean }> {
    await pool.query(
      `UPDATE konektag.merchant_profiles SET agent_enabled = $1, version = version + 1 WHERE id = $2 AND deleted_at IS NULL`,
      [enabled, merchantProfileId],
    );
    await pool.query(
      `INSERT INTO konektag.card_audit_log (card_id, action, user_id) VALUES ($1,'AGENT_' || $2,$3)`,
      [merchantProfileId, enabled ? 'ENABLED' : 'DISABLED', adminUserId],
    );
    return { success: true };
  },

  async listAgentMerchants(): Promise<any[]> {
    const { rows } = await pool.query(
      `SELECT mp.id, mp.business_name, mp.agent_enabled, mp.city, mp.country, mp.status
       FROM konektag.merchant_profiles mp
       WHERE mp.deleted_at IS NULL AND mp.status = 'Published'
       ORDER BY mp.business_name`,
    );
    return rows;
  },

  async getCommissionRates(merchantProfileId: string): Promise<any[]> {
    const { rows } = await pool.query(
      `SELECT id, country_code, commission_rate, is_active, created_at, updated_at
       FROM konektag.agent_commission_rates
       WHERE merchant_profile_id = $1
       ORDER BY country_code`,
      [merchantProfileId],
    );
    return rows;
  },

  async upsertCommissionRate(merchantProfileId: string, countryCode: string, rate: number, isActive: boolean): Promise<void> {
    await pool.query(
      `INSERT INTO konektag.agent_commission_rates (merchant_profile_id, country_code, commission_rate, is_active)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (merchant_profile_id, country_code)
       DO UPDATE SET commission_rate = $3, is_active = $4, updated_at = now(), version = version + 1`,
      [merchantProfileId, countryCode, rate, isActive],
    );
  },

  async deleteCommissionRate(rateId: string): Promise<void> {
    await pool.query(
      `DELETE FROM konektag.agent_commission_rates WHERE id = $1`,
      [rateId],
    );
  },

  async getMerchantSalesHistory(userId: string, from?: string, to?: string): Promise<{
    weekSold: number; weekValue: number; monthSold: number; monthValue: number;
    todaySold: number; todayValue: number; cards: any[];
  }> {
    const client = await pool.connect();
    try {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const weekStart = new Date(now); weekStart.setDate(now.getDate() - 7);
      const monthStart = new Date(now); monthStart.setMonth(now.getMonth() - 1);

      const { rows: [todayStats] } = await client.query(
        `SELECT COUNT(*)::int as count, COALESCE(SUM(amount), 0)::int as value
         FROM konektag.cards WHERE sold_by = $1 AND sold_at >= $2 AND deleted_at IS NULL`,
        [userId, today],
      );
      const { rows: [weekStats] } = await client.query(
        `SELECT COUNT(*)::int as count, COALESCE(SUM(amount), 0)::int as value
         FROM konektag.cards WHERE sold_by = $1 AND sold_at >= $2 AND deleted_at IS NULL`,
        [userId, weekStart.toISOString()],
      );
      const { rows: [monthStats] } = await client.query(
        `SELECT COUNT(*)::int as count, COALESCE(SUM(amount), 0)::int as value
         FROM konektag.cards WHERE sold_by = $1 AND sold_at >= $2 AND deleted_at IS NULL`,
        [userId, monthStart.toISOString()],
      );

      const params: any[] = [userId];
      const conditions = ['c.sold_by = $1', 'c.deleted_at IS NULL'];
      let idx = 2;
      if (from) { conditions.push(`c.sold_at >= $${idx++}`); params.push(from); }
      if (to) { conditions.push(`c.sold_at <= $${idx++}`); params.push(to); }

      const { rows: cards } = await client.query(
        `SELECT c.number, c.amount, c.status, c.sold_at, c.redeemed_at as activated_at
         FROM konektag.cards c WHERE ${conditions.join(' AND ')} ORDER BY c.sold_at DESC LIMIT 200`,
        params,
      );

      return {
        todaySold: todayStats?.count ?? 0, todayValue: todayStats?.value ?? 0,
        weekSold: weekStats?.count ?? 0, weekValue: weekStats?.value ?? 0,
        monthSold: monthStats?.count ?? 0, monthValue: monthStats?.value ?? 0,
        cards: cards.map((c: any) => ({
          number: c.number, amount: c.amount, status: c.status,
          soldAt: c.sold_at, activatedAt: c.activated_at,
        })),
      };
    } finally {
      client.release();
    }
  },
};

function getCardQrDataUrl(number: string): string {
  const svg = QRCode.toString(number, {
    type: 'svg',
    width: 400,
    margin: 2,
    color: { dark: '#000', light: '#fff' },
    errorCorrectionLevel: 'M',
  });
  if (typeof svg !== 'string') throw new Error('Failed to generate QR code');
  return svg;
}
