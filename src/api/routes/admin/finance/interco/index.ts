import type { RouteHandler } from '../../../../http';
import { financeReadRepository } from '../../../../../infrastructure/repositories/finance-read-repository.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../../application/services/backoffice-permission-service.ts';

export const GET: RouteHandler = async (context) => {
  const guard = await requireBackofficePermission('interco:read')(context.locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  const { request } = context;
  const url = new URL(request.url);
  try {
    const le = url.searchParams.get('legal_entity');
    const counterparty = url.searchParams.get('counterparty_entity');
    const debtor = url.searchParams.get('debtor_legal_entity');
    const data = await financeReadRepository.listIntercompany({
      legalEntity: le || undefined, counterparty: counterparty || undefined, debtor: debtor || undefined,
    });

    return new Response(JSON.stringify({
      data: data.map((p: any) => ({
        ...p,
        gross_position_amount: Number(p.gross_position_amount || 0),
        source_k_quantity: Number(p.source_k_quantity || 0),
      })),
      total: data.length,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
