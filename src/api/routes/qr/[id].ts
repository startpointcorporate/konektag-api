import type { RouteHandler } from '../../http';
import { qrService } from '../../../application/services/qr-service.ts';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ params, locals }) => {
  try {
    if (!params.id) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    const qr = await qrService.getQR(params.id);
    let payment = null;
    const { rows: payments } = await pool.query(
      `SELECT financial_transaction_id AS name, payer_user_id AS client, amount,
              consumed_at AS payment_time, 'Paid' AS status
       FROM konektag.checkout_intents WHERE public_id = $1 AND status = 'CONSUMED'`, [params.id]);
    if (payments.length) payment = payments[0];
    const currentUser = (locals as any).user;
    let isOwner = false;
    if (currentUser) {
      // QR personnel : etablissement = user.id
      if (qr.etablissement === currentUser.id) {
        isOwner = true;
      } else {
        // QR commerçant : vérifier si l'utilisateur est membre du commerce lié
        const resolved = await qrService.resolveMerchantFromEtablissement(qr.etablissement);
        if (resolved) {
          const { rows: [member] } = await pool.query(
            `SELECT 1 FROM konektag.merchant_memberships
             WHERE merchant_profile_id = $1 AND user_id = $2 AND status = 'active' AND role IN ('owner', 'manager')`,
            [resolved, currentUser.id],
          );
          if (member) isOwner = true;
        }
      }
    }
    return new Response(JSON.stringify({ ...qr, payment, is_owner: isOwner }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 404 });
  }
};
