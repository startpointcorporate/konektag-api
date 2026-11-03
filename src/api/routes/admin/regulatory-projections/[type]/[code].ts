import type { RouteHandler } from '../../../../http';
import { requireBackofficePermission, forbiddenResponse } from '../../../../../application/services/backoffice-permission-service.ts';
import { frappeMasterDataProjectionService } from '../../../../../application/services/frappe-master-data-projection-service.ts';

export const POST: RouteHandler = async ({ locals, params }) => {
  const guard = await requireBackofficePermission('compliance:write')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);

  try {
    const code = params.code;
    if (!code || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) throw new Error('PROJECTION_CODE_INVALID');
    const result = params.type === 'legal-entity'
      ? await frappeMasterDataProjectionService.projectLegalEntity(code)
      : params.type === 'regulated-actor'
        ? await frappeMasterDataProjectionService.projectRegulatedActor(code)
      : params.type === 'regulatory-profile'
        ? await frappeMasterDataProjectionService.projectRegulatoryProfile(code)
      : params.type === 'k-cashback-rule'
        ? await frappeMasterDataProjectionService.projectKCashbackRule(code)
        : (() => { throw new Error('PROJECTION_TYPE_INVALID'); })();
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
};
