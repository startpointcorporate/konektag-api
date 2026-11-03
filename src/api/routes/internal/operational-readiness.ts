/**
 * GAP-024 — protected operational readiness evidence (Runbook V3 P19/P20).
 *
 * Deterministic post-deployment verification boundary for the mandatory
 * workers and scheduled controls. Exposes only sanitized evidence: process
 * identifiers, health states, reason codes, timestamps and the immutable
 * application version. Never exposes configuration, credentials, connection
 * strings, tokens, stack traces, payloads or personal data.
 *
 * Authorization: Bearer INTERNAL_API_TOKEN (same model as other internal
 * endpoints). Anonymous and unauthorized access are rejected with 401.
 */

import type { RouteHandler } from '../../http';
import { computeOperationalReadiness } from '../../../application/services/operational-health-service.ts';

export const GET: RouteHandler = async ({ request }) => {
  const expected = process.env.INTERNAL_API_TOKEN;
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!expected || !token || token !== expected) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const readiness = await computeOperationalReadiness();
  return new Response(JSON.stringify({
    ready: readiness.ready,
    reasonCode: readiness.reasonCode,
    version: readiness.version,
    processes: readiness.processes,
    timestamp: new Date().toISOString(),
  }), { status: readiness.ready ? 200 : 503 });
};
