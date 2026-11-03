import type { RouteHandler } from '../../../../http';
import { requireBackofficePermission, forbiddenResponse } from '../../../../../application/services/backoffice-permission-service.ts';
import pool from '../../../../../infrastructure/database/pool.ts';
import { financialTransactionService } from '../../../../../application/services/financial-transaction-service.ts';

export const POST: RouteHandler = async ({ params, request, locals }) => {
  const guard = await requireBackofficePermission('recharges:write')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);

  const rechargeName = decodeURIComponent(params.id as string);
  try {
    const { rows: [proj] } = await pool.query(
      `SELECT keycloak_id, requested_amount, requested_currency, recharge_status, payment_method
       FROM konektag.recharge_projection WHERE recharge_name = $1 AND deleted_at IS NULL`,
      [rechargeName],
    );
    if (!proj) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    if (proj.recharge_status !== 'confirmed') return new Response(JSON.stringify({ error: 'Recharge non confirmee' }), { status: 409 });

    const idempotencyKey = `REFUND-CRYPTO-${rechargeName}`;
    const amount = Number(proj.requested_amount);

    const { rows: [entity] } = await pool.query(
      `SELECT id FROM konektag.legal_entities WHERE code = 'KTG-FR' AND deleted_at IS NULL`,
    );
    const { rows: [profile] } = await pool.query(
      `SELECT id FROM konektag.regulatory_profiles WHERE profile_code = 'ACQ-FR-STRIPE' AND deleted_at IS NULL`,
    );
    const legalEntityId = entity?.id;
    const regulatoryProfileId = profile?.id;
    if (!legalEntityId || !regulatoryProfileId) {
      return new Response(JSON.stringify({ error: 'Configuration entite/profil manquante pour le remboursement Crypto' }), { status: 500 });
    }

    const result = await financialTransactionService.execute({
      idempotencyKey,
      operationId: `RVSL-crypto-${rechargeName}`,
      operation: 'refund',
      legalEntityId,
      corridorId: 'FR-FR',
      regulatoryProfileId,
      currency: 'XOF',
      valueDate: new Date().toISOString().slice(0, 10),
      entries: [
        { clientId: proj.keycloak_id, accountCode: '1000', side: 'credit', amount, description: `Remboursement Crypto — ${rechargeName}` },
        { clientId: proj.keycloak_id, accountCode: '9000', side: 'debit', amount, description: `Remboursement emis — ${rechargeName}` },
      ],
    });

    return new Response(JSON.stringify({ success: true, transactionId: result.financialTransactionId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
