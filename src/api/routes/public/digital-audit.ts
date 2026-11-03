import type { RouteHandler } from '../../http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import pool from '../../../infrastructure/database/pool.ts';

const Schema = z.object({
  business: z.string().trim().min(2).max(150),
  website: z.union([z.literal(''), z.string().url().max(500)]).optional(),
  country: z.string().trim().min(2).max(80),
  city: z.string().trim().min(2).max(80),
  sector: z.string().trim().min(2).max(120),
  social: z.string().max(500).optional(),
  email: z.string().trim().email().max(254),
  locale: z.enum(['fr', 'en']).default('fr'),
  websiteField: z.string().max(200).optional(),
});
const json = (value: unknown, status: number) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export const POST: RouteHandler = async ({ request }) => {
  const origin = request.headers.get('origin');
  // The public Origin may differ from request.url behind the K3s reverse proxy.
  // Compare against explicit public origins; do not trust forwarded host headers.
  const allowedOrigins = new Set([
    'https://www.konektag.eu',
    'https://konektag.eu',
  ]);
  if (origin && !allowedOrigins.has(origin)) return json({ error: 'FORBIDDEN_ORIGIN' }, 403);
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'INVALID_REQUEST' }, 422);
  if (parsed.data.websiteField) return json({ error: 'INVALID_REQUEST' }, 422);
  const { business, website, country, city, sector, social, email, locale } = parsed.data;
  // Transaction-scoped advisory lock serializes submissions for the same email
  // across all frontend replicas sharing the PostgreSQL database.
  const client = await pool.connect().catch(() => null);
  if (!client) return json({ error: 'SERVICE_UNAVAILABLE' }, 503);
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [email.trim().toLowerCase()]);
    const { erpnext } = await import('../../../infrastructure/adapters/erpnext-adapter.ts');
    // Reuse an existing contact rather than creating another Lead.
    // Do not disclose CRM identifiers to unauthenticated callers.
    const normalizedEmail = email.trim().toLowerCase();
    // Business rule: only CANCELLED audits allow a new submission.
    // The PostgreSQL advisory lock serializes concurrent requests by email.
    const audits = await erpnext.list('Digital Audit', { email: normalizedEmail }, ['name', 'status'], 1000);
    if (!Array.isArray(audits) || audits.length >= 1000) throw new Error('CRM_AUDIT_LOOKUP_INCOMPLETE');
    if (audits.some((audit: { status?: string }) => audit.status !== 'CANCELLED')) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return json({ error: 'AUDIT_ALREADY_EXISTS' }, 409);
    }
    const contacts = await erpnext.list('Contact', { email_id: normalizedEmail }, ['name'], 2);
    if (!Array.isArray(contacts) || contacts.length > 1) {
      throw new Error('CRM_CONTACT_IDENTITY_AMBIGUOUS');
    }
    // A digital audit does not create a Lead. Lead remains a field-sales entity.
    let contactName: string;
    if (contacts.length === 1) {
      contactName = contacts[0].name;
    } else {
      // Existing Leads may have generated a Contact not found by this email index.
      // Fail closed rather than create a duplicate Contact.
      const linkedLeads = await erpnext.list('Lead', { email_id: normalizedEmail }, ['name'], 2);
      if (!Array.isArray(linkedLeads) || linkedLeads.length > 0) {
        throw new Error('CRM_CONTACT_RECONCILIATION_REQUIRED');
      }
      const created = await erpnext.create('Contact', {
        first_name: business,
        status: 'Passive',
        email_ids: [{ email_id: normalizedEmail, is_primary: 1 }],
        custom_funnel_stage: 'NEW',
        custom_funnel_result: 'PENDING',
      });
      if (!created?.name) throw new Error('CRM_CONTACT_CREATION_UNCONFIRMED');
      contactName = created.name;
    }

    const requestId = randomUUID();
    const audit = await erpnext.create('Digital Audit', {
      request_id: requestId,
      contact: contactName,
      email: normalizedEmail,
      company_name: business,
      country,
      city,
      sector,
      website: website || '',
      social_links: social || '',
      locale,
      status: 'NEW',
      source: 'KONEKTAG Website',
      requested_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    if (!audit?.name || audit.request_id !== requestId) {
      throw new Error('CRM_AUDIT_CREATION_UNCONFIRMED');
    }

    const contact = await erpnext.get('Contact', contactName);
    if (!contact || contact.name !== contactName) throw new Error('CRM_CONTACT_READ_UNCONFIRMED');
    if (contact.custom_funnel_stage !== 'COMPLETED' ||
        contact.custom_funnel_result !== 'INTERESTED') {
      const updated = await erpnext.update('Contact', contactName, {
        custom_funnel_stage: 'COMPLETED',
        custom_funnel_result: 'INTERESTED',
      });
      if (updated?.custom_funnel_stage !== 'COMPLETED' ||
          updated?.custom_funnel_result !== 'INTERESTED') {
        throw new Error('CRM_FUNNEL_UPDATE_UNCONFIRMED');
      }
    }
    const responseStatus = 201;

    // Durable Mautic tagging event for the persisted Digital Audit.
    // The worker retries delivery if Mautic is temporarily unavailable.
    const event = await client.query(
      `INSERT INTO konektag.outbox_events
         (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
       VALUES ($1, 'DigitalAudit', $2, 'DigitalAuditRequested', 1, $3)
       RETURNING id`,
      [randomUUID(), randomUUID(), JSON.stringify({ email: normalizedEmail, audit_request_id: requestId })],
    );
    const outboxId = event.rows?.[0]?.id;
    if (typeof outboxId !== 'string') throw new Error('OUTBOX_INSERT_UNCONFIRMED');

    await client.query('COMMIT');
    transactionOpen = false;

    // Fast path: apply the tag immediately, without waiting for the dispatcher.
    // A failure is NOT lost: the committed outbox event remains pending.
    try {
      const { mauticAdapter } = await import('../../../infrastructure/adapters/mautic-adapter.ts');
      await mauticAdapter.markAuditRequestedByEmail(normalizedEmail);
      await pool.query(
        `UPDATE konektag.outbox_events
            SET processed_at = now(), attempts = attempts + 1
          WHERE id = $1 AND processed_at IS NULL`,
        [outboxId],
      );
    } catch {
      // No PII or provider errors in logs; monitor the existing outbox retries.
      console.warn('[digital-audit] Mautic audit tag queued for retry');
    }
    return json({ status: 'received' }, responseStatus);
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    console.error('[digital-audit] CRM persistence failed', error);
    return json({ error: 'SERVICE_UNAVAILABLE' }, 503);
  } finally {
    client.release();
  }
};
