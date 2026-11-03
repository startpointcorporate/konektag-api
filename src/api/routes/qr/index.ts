import type { RouteHandler } from '../../http';
import { merchantActivationService } from '../../../application/services/merchant-activation-service.ts';
import { qrService } from '../../../application/services/qr-service.ts';
import pool from '../../../infrastructure/database/pool.ts';
import { merchantService } from '../../../application/merchant-service.ts';
import { MerchantNotOwnerError } from '../../../domain/MerchantErrors.ts';
import { QRValidationError } from '../../../application/services/qr-service.ts';

async function resolveMerchantProfileId(userId: string, requestedId?: string | null): Promise<string | null> {
  const { rows: [member] } = await pool.query(
    `SELECT mm.merchant_profile_id FROM konektag.merchant_memberships mm
     JOIN konektag.merchant_profiles mp ON mp.id = mm.merchant_profile_id
     WHERE mm.user_id = $1 AND mm.status = 'active'
       AND ($2::uuid IS NULL OR mm.merchant_profile_id = $2::uuid)
       AND mm.role IN ('owner', 'manager')
       AND mp.deleted_at IS NULL
     LIMIT 1`,
    [userId, requestedId || null],
  );
  return member?.merchant_profile_id || null;
}

/** POST /api/qr — scan / process QR payment / create QR */
export const POST: RouteHandler = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'pay') {
      return new Response(JSON.stringify({ error: 'Use /api/qr/request-confirmation' }), { status: 400 });
    }

    if (action === 'create_qr') {
      const { merchantProfileId, qrType, amount, reference, expiresInMinutes, signedToken, personal } = body;
      const profileId = personal === true ? null : await resolveMerchantProfileId(user.id, merchantProfileId || null);
      if (personal !== true && merchantProfileId && !profileId) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
      if (profileId) {
        const activation = await merchantActivationService.requireMerchantApproved(profileId);
        if (!activation.ok) return Response.json({ error: 'MERCHANT_NOT_ACTIVATED', reason: activation.error }, { status: 403 });
      }
      const result = await qrService.createQR({
        merchantProfileId: profileId || undefined,
        userId: user.id,
        qrType: qrType || 'Dynamic',
        amount: amount === undefined || amount === null || amount === '' ? undefined : Number(amount),
        reference,
        expiresInMinutes: expiresInMinutes || 15,
        signedToken,
      });
      console.log('[api/qr.create_qr] result keys:', Object.keys(result || {}), 'name:', result?.name);
      // Ajouter un nom lisible pour le QR data côté frontend (commerçant ou utilisateur)
      let recipientName = 'Commerçant';
      if (profileId) {
        const { rows: [mp] } = await pool.query(
          `SELECT business_name FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`,
          [profileId],
        );
        if (mp?.business_name) recipientName = mp.business_name;
      } else {
        recipientName = user.username || user.email?.split('@')[0] || 'Utilisateur';
      }
      return new Response(JSON.stringify({ ...result, _recipient_name: recipientName }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }

    if (action === 'create_qr_legacy') {
      // Ancien contrat avec etablissementId — rejeté pour forcer la migration
      return new Response(JSON.stringify({
        error: 'MERCHANT_ESTABLISHMENT_DEPRECATED: utiliser merchantProfileId',
      }), { status: 400 });
    }

    return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
  } catch (err: any) {
    if (err.name === 'QRValidationError') {
      return new Response(JSON.stringify({ error: err.message }), { status: 403 });
    }
    console.error('[api/qr] POST error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

/** GET /api/qr?type=client|merchant — list QR payments */
export const GET: RouteHandler = async ({ url, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  try {
    const type = url.searchParams.get('type') || 'client';
    if (type === 'target') {
      const requestedType = url.searchParams.get('beneficiaryType');
      const requestedMerchant = url.searchParams.get('merchantProfileId');
      const forcePersonal = requestedType === 'USER';
      const profileId = forcePersonal ? null : await resolveMerchantProfileId(user.id, requestedMerchant);
      if (profileId) {
        const { rows: [profile] } = await pool.query(
          `SELECT id, business_name FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`, [profileId]);
        const context = await (await import('../../../application/services/operation-currency-service.ts')).resolveMerchantOperationCurrency(pool, profileId);
        return new Response(JSON.stringify({ beneficiaryType: 'MERCHANT', beneficiaryId: profile.id, displayName: profile.business_name, currency: context.currency }), { headers: { 'Content-Type': 'application/json' } });
      }
      const context = await (await import('../../../application/services/operation-currency-service.ts')).resolveUserOperationCurrency(pool, user.id);
      return new Response(JSON.stringify({ beneficiaryType: 'USER', beneficiaryId: user.id, displayName: user.username || user.email?.split('@')[0] || 'Utilisateur', currency: context.currency }), { headers: { 'Content-Type': 'application/json' } });
    }
    const merchantProfileId = url.searchParams.get('merchantProfileId');
    if (type === 'merchant') {
      if (!merchantProfileId) {
        return new Response(JSON.stringify({ error: 'merchantProfileId requis pour les listes marchand' }), { status: 400 });
      }
      await merchantService.requireOwnerOrManager(merchantProfileId, user.id);
      const payments = await qrService.listMerchantPayments(merchantProfileId);
      return new Response(JSON.stringify(payments), { headers: { 'Content-Type': 'application/json' } });
    }
    const payments = await qrService.listClientPayments(user.id);
    return new Response(JSON.stringify(payments), { headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    if (err instanceof MerchantNotOwnerError) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
    console.error('[api/qr] GET error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
