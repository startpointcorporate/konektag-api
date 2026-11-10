import type { RouteHandler } from '../../../http';
import { authenticateSite, LinkPaySiteError } from '../../../../application/link-pay/frappe-site-routing.ts';
import { regularize, RegularizationError } from '../../../../application/network-operations/regularization.ts';

/**
 * "Régulariser" from the Frappe back-office of a Network site (X-Konektag-Frappe-Site + token).
 * Body: { key, option: options | verify | confirm_paid | confirm_failed, operator: { user, roles },
 *         reason?, evidence?: { reference, amount, currency, fileName, fileSha256 } }.
 * The site, the operation's owner and the operator's role are checked here, whatever the caller.
 */
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export const POST: RouteHandler = async ({ request }) => {
  try {
    const site = authenticateSite(request);
    const body = await request.json().catch(() => null) as any;
    if (!body || typeof body.key !== 'string' || typeof body.option !== 'string') return json({ error: 'REQUEST_INVALID' }, 400);
    const operator = { user: String(body.operator?.user || ''),
      roles: Array.isArray(body.operator?.roles) ? body.operator.roles.filter((r: unknown) => typeof r === 'string') : [] };
    return json(await regularize({ site: site.key, key: body.key, option: body.option, operator,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : undefined }));
  } catch (error) {
    if (error instanceof LinkPaySiteError) return json({ error: error.code }, error.status);
    if (error instanceof RegularizationError) return json({ error: error.code }, error.status);
    console.error('[network-operations] regularization failed', (error as Error).message);
    return json({ error: 'REGULARIZATION_UNAVAILABLE', result: 'temporary_failure' }, 503);
  }
};
