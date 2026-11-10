import crypto from 'crypto';
import pool from '../../infrastructure/database/pool.ts';
import { countryCodeFromInput } from '../shared/konektag-site.ts';

/** Frappe site the master data is read from; the routed Konektag site for a checkout. */
export type MasterDataSource = { get: (doctype: string, name: string) => Promise<any> };

type FrappeLegalEntity = {
  entity_code: string;
  entity_name: string;
  company: string;
  country: string;
  currency: string;
  status: 'Draft' | 'Approved' | 'Suspended';
  modified: string;
};

type FrappeRegulatoryProfile = {
  profile_code: string;
  legal_entity: string;
  corridor: string;
  runtime_operation: string;
  rail: string;
  fund_holder: string;
  runtime_actor_code?: string;
  runtime_execution_mode: string;
  min_kyc_level: string;
  max_amount_per_tx?: number | null;
  max_amount_daily?: number | null;
  max_amount_monthly?: number | null;
  evidence_required?: string;
  purpose?: string;
  valid_from: string;
  valid_until?: string | null;
  status: 'Draft' | 'Compliance Review' | 'Approved' | 'Suspended' | 'Expired';
  modified: string;
};

type FrappeKCashbackRule = {
  payment_country: string;
  rail: 'qr' | 'payment_link';
  rate_bps: number;
  valid_from: string;
  valid_until?: string | null;
  status: 'Approved' | 'Suspended' | 'Expired';
  modified: string;
};

type FrappeRegulatedActor = {
  actor_code: string;
  actor_name: string;
  actor_type: 'psp' | 'eme' | 'bank' | 'mobile_money_operator' | 'crypto_exchange' | 'internal';
  jurisdiction: string;
  license_ref?: string | null;
  license_valid_from?: string | null;
  license_valid_until?: string | null;
  runtime_technical_provider?: string | null;
  status: 'Draft' | 'Pending Approval' | 'Approved' | 'Rejected' | 'Suspended';
  modified: string;
};

const legalEntityStatuses = { Draft: 'NOT_CONFIGURED', Approved: 'APPROVED', Suspended: 'SUSPENDED' } as const;
const profileStatuses = {
  Draft: 'DRAFT', 'Compliance Review': 'PENDING_APPROVAL', Approved: 'APPROVED', Suspended: 'SUSPENDED', Expired: 'EXPIRED',
} as const;
const regulatedActorStatuses = {
  Draft: 'NOT_CONFIGURED', 'Pending Approval': 'PENDING_APPROVAL', Approved: 'APPROVED', Rejected: 'REVOKED', Suspended: 'SUSPENDED',
} as const;

async function erpnextClient(source?: MasterDataSource): Promise<MasterDataSource> {
  return source ?? (await import('../../infrastructure/adapters/erpnext-adapter.ts')).erpnext;
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function countryCode(country: string): string {
  const normalized = country.trim().toUpperCase();
  if (normalized === 'FRANCE') return 'FR';
  if (normalized === 'CONGO' || normalized === 'REPUBLIC OF THE CONGO') return 'CG';
  if (normalized === 'IRELAND') return 'IE';
  if (/^[A-Z]{2}$/.test(normalized)) return normalized;
  // Any other Frappe Country name (Lebanon, Liban…).
  const code = countryCodeFromInput(country);
  if (!code) throw new Error('FRAPPE_LEGAL_ENTITY_COUNTRY_INVALID');
  return code;
}

function evidence(value?: string): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error();
    return parsed;
  } catch {
    throw new Error('FRAPPE_REGULATORY_PROFILE_EVIDENCE_INVALID');
  }
}

async function record(client: any, sourceType: string, sourceCode: string, payloadHash: string, errorMessage: string | null = null) {
  await client.query(
    `INSERT INTO konektag.master_data_projections (source_type, source_code, payload_hash, projection_status, error_message)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_type, source_code) DO UPDATE
       SET payload_hash = EXCLUDED.payload_hash, projection_status = EXCLUDED.projection_status,
           error_message = EXCLUDED.error_message, projected_at = now()`,
    [sourceType, sourceCode, payloadHash, errorMessage ? 'FAILED' : 'PROJECTED', errorMessage],
  );
}

/** Explicit runtime pull from Frappe Foundation. It never writes regulatory master data back to Frappe. */
export const frappeMasterDataProjectionService = {
  async projectRegulatedActor(code: string, source?: MasterDataSource): Promise<{ code: string; status: string; changed: boolean }> {
    const actor = await (await erpnextClient(source)).get('Konektag Regulated Actor', code) as FrappeRegulatedActor;
    const status = regulatedActorStatuses[actor.status];
    const payload = {
      code, name: actor.actor_name?.trim(), type: actor.actor_type, jurisdiction: countryCode(actor.jurisdiction),
      licenseRef: actor.license_ref?.trim() || null, licenseValidFrom: actor.license_valid_from ?? null,
      licenseValidUntil: actor.license_valid_until ?? null, status, modified: actor.modified,
      technicalProvider: actor.runtime_technical_provider?.trim().toLowerCase() || null,
    };
    if (actor.actor_code !== code || !payload.name || !payload.type || !payload.jurisdiction || !status
      || (status === 'APPROVED' && (!payload.licenseRef || !payload.licenseValidFrom))) {
      throw new Error('FRAPPE_REGULATED_ACTOR_INVALID');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const projectionHash = hash(payload);
      const { rows } = await client.query(
        `INSERT INTO konektag.regulated_actors (
           actor_code, actor_name, actor_type, jurisdiction, license_ref, license_valid_from, license_valid_until,
           technical_provider, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (actor_code) DO UPDATE SET
           actor_name = EXCLUDED.actor_name, actor_type = EXCLUDED.actor_type, jurisdiction = EXCLUDED.jurisdiction,
           license_ref = EXCLUDED.license_ref, license_valid_from = EXCLUDED.license_valid_from,
           license_valid_until = EXCLUDED.license_valid_until, technical_provider = EXCLUDED.technical_provider,
           status = EXCLUDED.status, version = konektag.regulated_actors.version + 1, updated_at = now()
         WHERE (konektag.regulated_actors.actor_name, konektag.regulated_actors.actor_type,
                konektag.regulated_actors.jurisdiction, konektag.regulated_actors.license_ref,
                konektag.regulated_actors.license_valid_from, konektag.regulated_actors.license_valid_until,
                konektag.regulated_actors.technical_provider, konektag.regulated_actors.status)
           IS DISTINCT FROM (EXCLUDED.actor_name, EXCLUDED.actor_type, EXCLUDED.jurisdiction,
                             EXCLUDED.license_ref, EXCLUDED.license_valid_from, EXCLUDED.license_valid_until,
                             EXCLUDED.technical_provider, EXCLUDED.status)
         RETURNING id`,
         [code, payload.name, payload.type, payload.jurisdiction, payload.licenseRef, payload.licenseValidFrom,
           payload.licenseValidUntil, payload.technicalProvider, status],
      );
      const count = await client.query(`SELECT count(*)::int AS count FROM konektag.regulated_actors WHERE actor_code = $1 AND deleted_at IS NULL`, [code]);
      if (count.rows[0].count !== 1) throw new Error('RUNTIME_REGULATED_ACTOR_AMBIGUOUS');
      await record(client, 'regulated_actor', code, projectionHash);
      await client.query('COMMIT');
      return { code, status, changed: rows.length === 1 };
    } catch (error) {
      await client.query('ROLLBACK');
      await record(client, 'regulated_actor', code, hash({ code }), error instanceof Error ? error.message : 'PROJECTION_FAILED');
      throw error;
    } finally {
      client.release();
    }
  },

  async projectLegalEntity(code: string, source?: MasterDataSource): Promise<{ code: string; status: string; changed: boolean }> {
    const entity = await (await erpnextClient(source)).get('Konektag Legal Entity', code) as FrappeLegalEntity;
    const status = legalEntityStatuses[entity.status];
    const payload = {
      code, legalName: entity.entity_name?.trim(), countryCode: countryCode(entity.country), currency: entity.currency?.trim(),
      company: entity.company?.trim(), status, modified: entity.modified,
    };
    if (entity.entity_code !== code || !payload.legalName || !payload.currency || !payload.company || !status) {
      throw new Error('FRAPPE_LEGAL_ENTITY_INVALID');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const projectionHash = hash(payload);
      const { rows } = await client.query(
        `INSERT INTO konektag.legal_entities (code, legal_name, country_code, base_currency, frappe_company, status, valid_from)
         VALUES ($1, $2, $3, $4, $5, $6::text, CASE WHEN $6::text = 'APPROVED' THEN CURRENT_DATE ELSE NULL END)
         ON CONFLICT (code) DO UPDATE SET
           legal_name = EXCLUDED.legal_name, country_code = EXCLUDED.country_code, base_currency = EXCLUDED.base_currency,
           frappe_company = EXCLUDED.frappe_company, status = EXCLUDED.status,
           valid_from = CASE WHEN EXCLUDED.status = 'APPROVED' THEN COALESCE(konektag.legal_entities.valid_from, CURRENT_DATE) ELSE konektag.legal_entities.valid_from END,
           version = konektag.legal_entities.version + 1, updated_at = now()
         WHERE (konektag.legal_entities.legal_name, konektag.legal_entities.country_code,
                konektag.legal_entities.base_currency, konektag.legal_entities.frappe_company,
                konektag.legal_entities.status)
           IS DISTINCT FROM (EXCLUDED.legal_name, EXCLUDED.country_code, EXCLUDED.base_currency,
                             EXCLUDED.frappe_company, EXCLUDED.status)
         RETURNING id`,
         [code, payload.legalName, payload.countryCode, payload.currency, payload.company, status],
      );
      const count = await client.query(`SELECT count(*)::int AS count FROM konektag.legal_entities WHERE code = $1 AND deleted_at IS NULL`, [code]);
      if (count.rows[0].count !== 1) throw new Error('RUNTIME_LEGAL_ENTITY_AMBIGUOUS');
      await record(client, 'legal_entity', code, projectionHash);
      await client.query('COMMIT');
      return { code, status, changed: rows.length === 1 };
    } catch (error) {
      await client.query('ROLLBACK');
      await record(client, 'legal_entity', code, hash({ code }), error instanceof Error ? error.message : 'PROJECTION_FAILED');
      throw error;
    } finally {
      client.release();
    }
  },

  async projectRegulatoryProfile(code: string, source?: MasterDataSource): Promise<{ code: string; status: string; changed: boolean }> {
    const profile = await (await erpnextClient(source)).get('Konektag Regulatory Profile', code) as FrappeRegulatoryProfile;
    const status = profileStatuses[profile.status];
    const payload = {
      code, legalEntity: profile.legal_entity, corridor: profile.corridor, operation: profile.runtime_operation,
      rail: profile.rail, fundHolder: profile.fund_holder, actorCode: profile.runtime_actor_code?.trim() || null,
      executionMode: profile.runtime_execution_mode,
      minKycLevel: profile.min_kyc_level, maxPerTx: profile.max_amount_per_tx ?? null,
      maxDaily: profile.max_amount_daily ?? null, maxMonthly: profile.max_amount_monthly ?? null,
      evidence: evidence(profile.evidence_required), purpose: profile.purpose?.trim() || null,
      validFrom: profile.valid_from, validUntil: profile.valid_until ?? null, status, modified: profile.modified,
    };
    if (profile.profile_code !== code || !status || !payload.legalEntity || !payload.corridor || !payload.operation || !payload.rail || !payload.fundHolder || !payload.executionMode || !payload.minKycLevel || !payload.validFrom) {
      throw new Error('FRAPPE_REGULATORY_PROFILE_INVALID');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: entities } = await client.query(`SELECT id FROM konektag.legal_entities WHERE code = $1 AND deleted_at IS NULL LIMIT 2`, [payload.legalEntity]);
      if (entities.length !== 1) throw new Error('RUNTIME_PROFILE_LEGAL_ENTITY_AMBIGUOUS');
      const { rows: actors } = payload.actorCode
        ? await client.query(`SELECT id, status FROM konektag.regulated_actors WHERE actor_code = $1 AND deleted_at IS NULL LIMIT 2`, [payload.actorCode])
        : { rows: [] as Array<{ id: string; status: string }> };
      if (payload.actorCode && actors.length !== 1) throw new Error('RUNTIME_REGULATED_ACTOR_AMBIGUOUS');
      if (status === 'APPROVED' && payload.actorCode && actors[0].status !== 'APPROVED') throw new Error('RUNTIME_REGULATED_ACTOR_NOT_APPROVED');
      const metadata = payload.purpose ? { purpose: payload.purpose } : {};
      const projectionHash = hash(payload);
      const { rows } = await client.query(
        `INSERT INTO konektag.regulatory_profiles (
           profile_code, profile_name, legal_entity_id, country_of_origin, country_of_destination, corridor_id,
           authorized_operation, fund_holder, regulated_actor_id, rail, execution_mode, min_kyc_level, max_amount_per_tx,
           max_amount_daily, max_amount_monthly, evidence_required, status, valid_from, valid_until, metadata
         )
         SELECT $1, $1, le.id, le.country_code, le.country_code, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                $12::jsonb, $13, $14, $15, $16::jsonb
          FROM konektag.legal_entities le WHERE le.id = $17
         ON CONFLICT (profile_code) DO UPDATE SET
           legal_entity_id = EXCLUDED.legal_entity_id, country_of_origin = EXCLUDED.country_of_origin,
           country_of_destination = EXCLUDED.country_of_destination, corridor_id = EXCLUDED.corridor_id,
           authorized_operation = EXCLUDED.authorized_operation, fund_holder = EXCLUDED.fund_holder,
           regulated_actor_id = EXCLUDED.regulated_actor_id, rail = EXCLUDED.rail, execution_mode = EXCLUDED.execution_mode,
           min_kyc_level = EXCLUDED.min_kyc_level,
           max_amount_per_tx = EXCLUDED.max_amount_per_tx, max_amount_daily = EXCLUDED.max_amount_daily,
           max_amount_monthly = EXCLUDED.max_amount_monthly, evidence_required = EXCLUDED.evidence_required,
           status = EXCLUDED.status, valid_from = EXCLUDED.valid_from, valid_until = EXCLUDED.valid_until,
           metadata = EXCLUDED.metadata, version = konektag.regulatory_profiles.version + 1, updated_at = now()
         WHERE (konektag.regulatory_profiles.legal_entity_id, konektag.regulatory_profiles.corridor_id,
                konektag.regulatory_profiles.authorized_operation, konektag.regulatory_profiles.fund_holder,
                konektag.regulatory_profiles.regulated_actor_id, konektag.regulatory_profiles.rail,
                konektag.regulatory_profiles.execution_mode,
                konektag.regulatory_profiles.min_kyc_level, konektag.regulatory_profiles.max_amount_per_tx,
                konektag.regulatory_profiles.max_amount_daily, konektag.regulatory_profiles.max_amount_monthly,
                konektag.regulatory_profiles.evidence_required, konektag.regulatory_profiles.status,
                konektag.regulatory_profiles.valid_from, konektag.regulatory_profiles.valid_until,
                konektag.regulatory_profiles.metadata)
           IS DISTINCT FROM (EXCLUDED.legal_entity_id, EXCLUDED.corridor_id, EXCLUDED.authorized_operation,
                EXCLUDED.fund_holder, EXCLUDED.regulated_actor_id, EXCLUDED.rail, EXCLUDED.execution_mode,
                EXCLUDED.min_kyc_level,
                EXCLUDED.max_amount_per_tx, EXCLUDED.max_amount_daily, EXCLUDED.max_amount_monthly,
                EXCLUDED.evidence_required, EXCLUDED.status, EXCLUDED.valid_from, EXCLUDED.valid_until, EXCLUDED.metadata)
         RETURNING id`,
        [code, payload.corridor, payload.operation, payload.fundHolder, actors[0]?.id ?? null, payload.rail,
          payload.executionMode, payload.minKycLevel, payload.maxPerTx, payload.maxDaily, payload.maxMonthly,
          JSON.stringify(payload.evidence), status, payload.validFrom, payload.validUntil, JSON.stringify(metadata), entities[0].id],
      );
      await record(client, 'regulatory_profile', code, projectionHash);
      await client.query('COMMIT');
      return { code, status, changed: rows.length === 1 };
    } catch (error) {
      await client.query('ROLLBACK');
      await record(client, 'regulatory_profile', code, hash({ code }), error instanceof Error ? error.message : 'PROJECTION_FAILED');
      throw error;
    } finally {
      client.release();
    }
  },
  async projectKCashbackRule(name: string, source?: MasterDataSource): Promise<{ name: string; status: string; changed: boolean }> {
    const rule = await (await erpnextClient(source)).get('Konektag K Cashback Rule', name) as FrappeKCashbackRule;
    const paymentCountry = countryCode(rule.payment_country);
    const rateBps = Number(rule.rate_bps);
    const status = rule.status === 'Approved' ? 'APPROVED' : rule.status === 'Suspended' ? 'SUSPENDED' : 'EXPIRED';
    if (!['qr','payment_link'].includes(rule.rail) || !Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10000
      || !rule.valid_from || (rule.valid_until && rule.valid_until <= rule.valid_from)) {
      throw new Error('FRAPPE_K_CASHBACK_RULE_INVALID');
    }
    const payload = { name, paymentCountry, rail: rule.rail, rateBps, validFrom: rule.valid_from,
      validUntil: rule.valid_until ?? null, status, modified: rule.modified };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const projectionHash = hash(payload);
      const { rows } = await client.query(
        `INSERT INTO konektag.payment_country_k_cashback_rules
          (payment_country,rail,rate_bps,valid_from,valid_until,status,frappe_reference)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(payment_country,rail,valid_from) DO UPDATE SET
          rate_bps=EXCLUDED.rate_bps,valid_until=EXCLUDED.valid_until,status=EXCLUDED.status,
          frappe_reference=EXCLUDED.frappe_reference
         WHERE (konektag.payment_country_k_cashback_rules.rate_bps,konektag.payment_country_k_cashback_rules.valid_until,
                konektag.payment_country_k_cashback_rules.status,konektag.payment_country_k_cashback_rules.frappe_reference)
           IS DISTINCT FROM (EXCLUDED.rate_bps,EXCLUDED.valid_until,EXCLUDED.status,EXCLUDED.frappe_reference)
         RETURNING payment_country`,
        [paymentCountry,rule.rail,rateBps,rule.valid_from,rule.valid_until??null,status,name],
      );
      await record(client,'k_cashback_rule',name,projectionHash);
      await client.query('COMMIT');
      return { name, status, changed: rows.length === 1 };
    } catch(error) {
      await client.query('ROLLBACK');
      await record(client,'k_cashback_rule',name,hash({name}),error instanceof Error?error.message:'PROJECTION_FAILED');
      throw error;
    } finally { client.release(); }
  },
};
