import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { minioAdapter } from '../../../../infrastructure/adapters/minio-adapter.ts';
import { emailService } from '../../../../application/services/resend-service.ts';
import { redisAdapter } from '../../../../infrastructure/adapters/redis-adapter.ts';
import { getCorrelationId } from '../../../../infrastructure/correlation-id.ts';

import { makerCheckerService } from '../../../../application/services/maker-checker-service.ts';
import { encryptionService } from '../../../../infrastructure/adapters/encryption-service.ts';

const ADMIN_CHECK = `SELECT role FROM konektag.users WHERE id = $1`;

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return null;
  const { rows: [u] } = await pool.query(ADMIN_CHECK, [user.id]);
  if (!u || u.role !== 'admin') return null;
  return user;
}

export const GET: RouteHandler = async ({ locals, request }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending_review';
  const orderId = url.searchParams.get('orderId');

  try {
    if (orderId) {
      const { rows: [r] } = await pool.query(
        `SELECT o.id, o.user_id, o.status, o.rejection_reason, o.attempt, o.ocr_data, o.created_at,
                u.username, u.state, u.encrypted_data
         FROM konektag.kyc_orders o
         JOIN konektag.users u ON u.id = o.user_id
         WHERE o.id = $1 AND u.deleted_at IS NULL`,
        [orderId],
      );
      if (!r) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
      let p: any = {};
      try { p = JSON.parse(encryptionService.decrypt(r.encrypted_data)); } catch {}
      const profile = {
        firstName: p.firstName || '',
        lastName: p.lastName || '',
        birthDate: p.birthDate || '',
        country: p.country || '',
      };
      return new Response(JSON.stringify({
        id: r.id, username: r.username, userState: r.state, status: r.status,
        attempt: r.attempt, createdAt: r.created_at, rejectionReason: r.rejection_reason,
        ocrData: r.ocr_data, profile,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const validStatuses = ['pending_review', 'verified', 'rejected'];
    const filterStatus = validStatuses.includes(status) ? status : 'pending_review';

    const { rows } = await pool.query(
      `SELECT o.id, o.user_id, o.status, o.id_document_path, o.rejection_reason, o.attempt,
              o.ocr_data, o.created_at, o.verified_at,
              u.username, u.state
       FROM konektag.kyc_orders o
       JOIN konektag.users u ON u.id = o.user_id
       WHERE o.status = $1 AND u.deleted_at IS NULL
       ORDER BY o.created_at DESC
       LIMIT 100`,
      [filterStatus],
    );

    const orders = rows.map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      userState: r.state,
      status: r.status,
      idDocumentPath: r.id_document_path,
      rejectionReason: r.rejection_reason,
      attempt: r.attempt,
      ocrData: r.ocr_data,
      createdAt: r.created_at,
      verifiedAt: r.verified_at,
    }));

    return new Response(JSON.stringify(orders), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[admin/kyc GET]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const POST: RouteHandler = async ({ locals, request }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  try {
    const body = await request.json();
    const { orderId, action, reason } = body;

    if (!orderId || !action || !['approve', 'reject'].includes(action)) {
      return new Response(JSON.stringify({ error: 'MISSING_FIELDS', required: ['orderId', 'action (approve|reject)'] }), { status: 400 });
    }
    if (action === 'reject' && (!reason || String(reason).trim().length < 3)) {
      return new Response(JSON.stringify({ error: 'REJECTION_REASON_REQUIRED', message: 'Un motif de refus est obligatoire.' }), { status: 400 });
    }

    const { rows: [order] } = await pool.query(
      `SELECT * FROM konektag.kyc_orders WHERE id = $1`,
      [orderId],
    );
    if (!order) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    if (order.status !== 'pending_review') {
      return new Response(JSON.stringify({ error: 'INVALID_STATUS', message: 'Cet ordre KYC n\'est pas en attente de revue' }), { status: 422 });
    }

    const client = await pool.connect();
    const correlationId = getCorrelationId();

    try {
      await client.query('BEGIN');

      if (action === 'approve') {
        // Resolve the real source location. Legacy KYC documents were stored in
        // the generic "konektag" bucket; current documents use the quarantine bucket.
        const verifiedBucket = process.env.MINIO_KYC_BUCKET || process.env.MINIO_BUCKET || 'konektag-kyc';
        const expectedVerifiedKey = order.id_document_path.replace(/^kyc\/quarantine\//, `kyc/verified/${orderId}/`);
        let definitiveKey: string;
        // A previous approval attempt may have copied+deleted the object before
        // the PostgreSQL transaction rolled back. Resume from the verified object
        // instead of requiring the quarantine source to still exist.
        try {
          const existingBucket = await minioAdapter.findReadableBucket(expectedVerifiedKey, [verifiedBucket]);
          definitiveKey = expectedVerifiedKey;
          console.info('[admin/kyc] approval resume from verified document', { orderId, bucket: existingBucket, key: definitiveKey });
        } catch {
          const sourceBucket = await minioAdapter.findReadableBucket(
            order.id_document_path,
            [
              process.env.MINIO_QUARANTINE_BUCKET || 'konektag-kyc-quarantine',
              process.env.MINIO_BUCKET || 'konektag',
            ],
          );
          definitiveKey = await minioAdapter.moveToDefinitive(
            order.id_document_path,
            orderId,
            sourceBucket,
            verifiedBucket,
          );
        }
        const presignedUrl = await minioAdapter.getPresignedUrl(
          verifiedBucket,
          definitiveKey,
        );

        await client.query(
          `UPDATE konektag.kyc_orders SET status = 'verified', id_document_path = $1, verified_at = now(), updated_at = now() WHERE id = $2`,
          [definitiveKey, orderId],
        );
        const { rows: [accountContext] } = await client.query(
          `SELECT u.state,
                  EXISTS (
                    SELECT 1
                    FROM konektag.user_preferences up
                    WHERE up.user_id = u.id
                      AND up.deleted_at IS NULL
                      AND jsonb_array_length(COALESCE(up.selected_features, '[]'::jsonb)) > 0
                  ) AS has_feature_selections
           FROM konektag.users u
           WHERE u.id = $1`,
          [order.user_id],
        );
        const nextUserState = accountContext?.has_feature_selections ? 'COMPLETED' : 'KYC_VALIDATED';

        await client.query(
          `UPDATE konektag.users SET state = $1, id_document_url = $2, kyc_last_evaluated_at = now(), kyc_expires_at = CURRENT_DATE + interval '1 year', updated_at = now()
           WHERE id = $3 AND state = 'KYC_PENDING_REVIEW'`,
          [nextUserState, presignedUrl, order.user_id],
        );

        await client.query(
          `INSERT INTO konektag.outbox_events (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
           VALUES ($1, 'KycOrder', $2, 'KycVerified', 1, $3)`,
          [correlationId, orderId, JSON.stringify({ userId: order.user_id })],
        );

        await client.query(
          `INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload)
           VALUES ($1, $2, 'KYC_APPROVED_BY_ADMIN', $3)`,
          [admin.id, correlationId, JSON.stringify({ kycOrderId: orderId, userId: order.user_id, adminId: admin.id, makerChecker: 'prepared' })],
        );

        await makerCheckerService.recordPreparation({
          actionType: 'KYC_APPROVE',
          targetType: 'kyc_order',
          targetId: orderId,
          makerId: admin.id,
          makerRole: 'admin',
          reason: `KYC approuve pour l'utilisateur ${order.user_id}`,
          payload: { kycOrderId: orderId, userId: order.user_id },
        }, client);

        await redisAdapter.publishKycStatus(order.user_id, {
          status: 'verified',
          step: 'KYC_VALIDATED',
          timestamp: new Date().toISOString(),
        });
      } else {
        await client.query(
          `UPDATE konektag.kyc_orders SET status = 'rejected', rejection_reason = $1, updated_at = now() WHERE id = $2`,
          [String(reason).trim(), orderId],
        );
        await client.query(
          `UPDATE konektag.users SET state = 'KYC_REJECTED', updated_at = now()
           WHERE id = $1 AND state = 'KYC_PENDING_REVIEW'`,
          [order.user_id],
        );

        await client.query(
          `INSERT INTO konektag.outbox_events (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
           VALUES ($1, 'KycOrder', $2, 'KycRejected', 1, $3)`,
          [correlationId, orderId, JSON.stringify({ userId: order.user_id, reason: 'Rejeté par l\'administrateur' })],
        );

        await client.query(
          `INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload)
           VALUES ($1, $2, 'KYC_REJECTED_BY_ADMIN', $3)`,
          [admin.id, correlationId, JSON.stringify({ kycOrderId: orderId, userId: order.user_id, adminId: admin.id, makerChecker: 'prepared' })],
        );

        await makerCheckerService.recordPreparation({
          actionType: 'KYC_REJECT',
          targetType: 'kyc_order',
          targetId: orderId,
          makerId: admin.id,
          makerRole: 'admin',
          reason: `KYC rejete pour l'utilisateur ${order.user_id}`,
          payload: { kycOrderId: orderId, userId: order.user_id },
        }, client);

        await redisAdapter.publishKycStatus(order.user_id, {
          status: 'rejected',
          step: 'KYC_REJECTED',
          reason: 'Document refusé après vérification manuelle.',
          timestamp: new Date().toISOString(),
        });
      }

      await client.query('COMMIT');

      return new Response(JSON.stringify({ success: true, action }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('[admin/kyc POST]', error);
    return new Response(JSON.stringify({ error: error.message || 'SERVER_ERROR' }), { status: 500 });
  }
};
