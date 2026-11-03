import type { RouteHandler } from '../../../../http';
import pool from '../../../../../infrastructure/database/pool.ts';
import { merchantActivationService } from '../../../../../application/services/merchant-activation-service.ts';
import { PaymentContextResolutionError, paymentContextResolver } from '../../../../../application/services/pay/payment-context-resolver.ts';
import { paymentCountryResolver } from '../../../../../application/services/pay/payment-country-resolver.ts';

async function adminGuard(locals: any) {
  const user = locals.user;
  if (!user) return null;
  const { rows: [row] } = await pool.query('SELECT role FROM konektag.users WHERE id=$1', [user.id]);
  return row?.role === 'admin' ? user : null;
}

export const GET: RouteHandler = async ({ locals, params }) => {
  if (!await adminGuard(locals)) return Response.json({ error: 'FORBIDDEN' }, { status: 403 });
  const id = params.id!;
  const { rows: [merchant] } = await pool.query(
    `SELECT id,business_name,slug,country,kyb_status,kyb_submitted_at,kyb_documents_verified,kyb_ubo_verified,
            kyb_sanctions_screened,kyb_contract_ref,kyb_contract_signed_at,kyb_settlement_account,
            kyb_settlement_rail,kyb_risk_category,kyb_approved_at,kyb_approved_by,kyb_complement_reason
     FROM konektag.merchant_profiles WHERE id=$1 AND deleted_at IS NULL`, [id]);
  if (!merchant) return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  const { rows: documents } = await pool.query(
    `SELECT id,document_type,title,file_url,mime_type,submitted_at
     FROM konektag.merchant_kyb_documents WHERE merchant_profile_id=$1 AND deleted_at IS NULL ORDER BY submitted_at DESC`, [id]);
  const activation = await merchantActivationService.checkActivation(id);
  let settlementOptions: any[] = [];
  let settlementResolution: { country: string; paymentCountry: string | null; operation: string; error: string | null } = {
    country: merchant.country,
    paymentCountry: null,
    operation: 'link_payment',
    error: null,
  };
  try {
    const countryRows = await (await import('../../../../../infrastructure/adapters/erpnext-adapter.ts')).erpnext.list(
      'Country', undefined, ['name', 'code'], 500,
    );
    const merchantCountry = String(merchant.country || '').trim().toUpperCase();
    const country = countryRows.find((row: any) =>
      String(row.name || '').trim().toUpperCase() === merchantCountry
      || (merchantCountry === 'CONGO' && String(row.code || '').trim().toUpperCase() === 'CG')
    );
    if (!country?.code) throw new Error('MERCHANT_COUNTRY_CODE_NOT_FOUND');
    const resolvedCountry = await paymentCountryResolver.resolve(String(country.code).toUpperCase());
    settlementResolution.paymentCountry = resolvedCountry.paymentCountry;
    const context = await paymentContextResolver.resolve(resolvedCountry.paymentCountry);
    settlementOptions = context.providers.map((p: any) => ({
      rail: p.regulatoryProfile.rail,
      corridor: p.corridor,
      provider: p.provider,
      providerConfigurationKey: p.providerConfigurationKey,
      paymentMethod: p.paymentMethod,
      label: p.paymentMethod === 'mobile_money' ? 'Mobile Money' : p.paymentMethod === 'card' ? 'Carte / Banque' : p.paymentMethod,
    }));
  } catch (error) {
    settlementResolution.error = error instanceof PaymentContextResolutionError
      ? error.code
      : error instanceof Error ? error.message : 'PAYMENT_CONTEXT_UNKNOWN_ERROR';
    console.error('[admin merchant KYB] settlement options unavailable', {
      country: merchant.country,
      operation: settlementResolution.operation,
      error: settlementResolution.error,
    });
  }
  return Response.json({ merchant, documents, missingGates: activation.missingGates, settlementOptions, settlementResolution });
};

export const PATCH: RouteHandler = async ({ locals, params, request }) => {
  const admin = await adminGuard(locals);
  if (!admin) return Response.json({ error: 'FORBIDDEN' }, { status: 403 });
  const id = params.id!;
  const body = await request.json();
  await pool.query(
    `UPDATE konektag.merchant_profiles SET
      kyb_documents_verified=COALESCE($1,kyb_documents_verified),
      kyb_ubo_verified=COALESCE($2,kyb_ubo_verified),
      kyb_sanctions_screened=COALESCE($3,kyb_sanctions_screened),
      kyb_contract_ref=COALESCE($4,kyb_contract_ref),
      kyb_contract_signed_at=COALESCE($5::date,kyb_contract_signed_at),
      kyb_settlement_account=COALESCE($6,kyb_settlement_account),
      kyb_settlement_rail=COALESCE($7,kyb_settlement_rail),
      kyb_risk_category=COALESCE($8,kyb_risk_category),
      kyb_complement_reason=$9,
      updated_at=now()
     WHERE id=$10 AND deleted_at IS NULL`,
    [body.documentsVerified,body.uboVerified,body.sanctionsScreened,body.contractRef||null,body.contractSignedAt||null,
     body.settlementAccount||null,body.settlementRail||null,body.riskCategory||null,body.complementReason??null,id]);
  return Response.json({ success: true });
};

export const POST: RouteHandler = async ({ locals, params, request }) => {
  const admin = await adminGuard(locals);
  if (!admin) return Response.json({ error: 'FORBIDDEN' }, { status: 403 });
  const id=params.id!;
  const { action, reason } = await request.json();
  if(action==='request_complement'){
    await pool.query(`UPDATE konektag.merchant_profiles SET kyb_status='DOCUMENTS_SUBMITTED',kyb_complement_reason=$1,updated_at=now() WHERE id=$2`,[reason||'Dossier à compléter',id]);
    return Response.json({success:true});
  }
  if(action==='approve'){
    const activation=await merchantActivationService.checkActivation(id);
    const remaining=activation.missingGates.filter(g=>g!=='merchant_approved');
    if(remaining.length) return Response.json({error:'KYB_GATES_MISSING',missingGates:remaining},{status:422});
    await merchantActivationService.activateMerchant(id,admin.id);
    return Response.json({success:true});
  }
  return Response.json({error:'INVALID_ACTION'},{status:400});
};
