import type { RouteHandler } from '../../../../http';
import pool from '../../../../../infrastructure/database/pool.ts';

export const POST: RouteHandler = async ({locals,request,params}) => {
  if(!locals.user?.id) return Response.json({error:'FORBIDDEN'},{status:403});
  const {rows:[actor]}=await pool.query(`SELECT role FROM konektag.users WHERE id=$1`,[locals.user.id]);
  if(!actor || !['admin','operations','finance_local','approver'].includes(actor.role)) return Response.json({error:'FORBIDDEN'},{status:403});
  const body=await request.json().catch(()=>({}));
  const reason=typeof body.reason==='string'?body.reason.trim():'';
  if(!reason) return Response.json({error:'REJECTION_REASON_REQUIRED'},{status:400});
  const {rows:[claim]}=await pool.query(`UPDATE konektag.payment_claims SET status='REJECTED',resolution=$2,resolved_by=$3,
    resolved_at=now(),updated_at=now() WHERE id=$1 AND status IN ('OPEN','AUTO_RECONCILING','PENDING_REVIEW','APPROVED') RETURNING id,status`,
    [params.id,reason,locals.user.id]);
  return claim?Response.json({claim}):Response.json({error:'CLAIM_NOT_REVIEWABLE'},{status:409});
};
