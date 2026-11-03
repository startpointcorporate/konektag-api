import type { RouteHandler } from '../../../../../http';
import pool from '../../../../../../infrastructure/database/pool.ts';
import { buildMerchantContract } from '../../../../../../application/shared/contract/merchant-contract-document.ts';

// Download only: no signed-contract reference, KYB approval, CRM write or email.
export const GET: RouteHandler = async ({ locals, params }) => {
  const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  if (!locals.user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers });
  try {
    const { rows: [admin] } = await pool.query('SELECT role FROM konektag.users WHERE id=$1 AND deleted_at IS NULL', [locals.user.id]);
    if (admin?.role !== 'admin') return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers });
    const id = params.id || '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return Response.json({ error: 'INVALID_MERCHANT_ID' }, { status: 400, headers });
    }
    const { rows: [merchant] } = await pool.query(
      `SELECT mp.*, u.encrypted_data AS owner_encrypted_data FROM konektag.merchant_profiles mp
       JOIN konektag.users u ON u.id=mp.user_id AND u.deleted_at IS NULL
       WHERE mp.id=$1 AND mp.deleted_at IS NULL`, [id]);
    if (!merchant) return Response.json({ error: 'MERCHANT_OR_OWNER_NOT_FOUND' }, { status: 404, headers });
    if (!String(merchant.business_name || '').trim()) return Response.json({ error: 'BUSINESS_NAME_REQUIRED' }, { status: 422, headers });
    if (merchant.owner_encrypted_data) {
      const { encryptionService } = await import('../../../../../../infrastructure/adapters/encryption-service.ts');
      merchant.ownerProfile = JSON.parse(encryptionService.decrypt(merchant.owner_encrypted_data));
    }
    // KYB is merchant-level: activity profiles may not exist at onboarding time.
    const document = buildMerchantContract(merchant);
    return new Response(new Uint8Array(document), { headers: {
      ...headers, 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="Contrat_Konektag_${id}.docx"`,
    } });
  } catch (error) {
    // Do not expose personal data, SQL details or cryptographic errors to the browser.
    console.error('[KYB contract] generation failed', {
      merchantId: params.id,
      cause: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string } | null)?.code,
    });
    return Response.json({ error: 'CONTRACT_GENERATION_FAILED' }, { status: 500, headers });
  }
};
