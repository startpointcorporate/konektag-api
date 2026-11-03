import pool from '../../infrastructure/database/pool.ts';
import {VisibilityError,visibilityId,visibilityText,visibilityManager,visibilityAdmin,visibilityTransaction} from './visibility-shared.ts';
export const REVIEW_VISIBLE_SQL="COALESCE((SELECT me.state FROM konektag.review_moderation_events me WHERE me.review_id=r.id ORDER BY me.revision DESC LIMIT 1),'VISIBLE')='VISIBLE'";
export const VERIFIED_CUSTOMER_SQL=`EXISTS(SELECT 1 FROM konektag.points_merchant_consumptions pc
 JOIN konektag.parties p ON p.id=pc.party_id JOIN konektag.users buyer ON buyer.keycloak_id=p.keycloak_id
 WHERE buyer.id=r.user_id AND pc.merchant_profile_id=r.merchant_id AND pc.status='completed' AND pc.created_at<=r.created_at
 AND pc.quantity>COALESCE((SELECT sum(pr.quantity) FROM konektag.points_merchant_refunds pr WHERE pr.consumption_id=pc.id),0))`;
export async function replyToReview(actorId:string,merchantId:string,reviewId:string,input:Record<string,unknown>){
 visibilityId(reviewId);const content=visibilityText(input.content,2000),version=input.expectedVersion;
 if(!Number.isInteger(version)||Number(version)<0)throw new VisibilityError('VERSION_REQUIRED');
 return visibilityTransaction(async db=>{const m=await visibilityManager(actorId,merchantId,db);if(m.status==='Suspended')throw new VisibilityError('MERCHANT_SUSPENDED',403);
 const {rows:[review]}=await db.query('SELECT id FROM konektag.reviews WHERE id=$1 AND merchant_id=$2 AND deleted_at IS NULL FOR UPDATE',[reviewId,merchantId]);if(!review)throw new VisibilityError('REVIEW_NOT_FOUND',404);
 const {rows:[last]}=await db.query('SELECT content,version FROM konektag.review_merchant_replies WHERE review_id=$1 ORDER BY version DESC LIMIT 1',[reviewId]);
 if(last?.version===Number(version)+1&&last.content===content)return last;
 if((last?.version||0)!==version)throw new VisibilityError('VERSION_CONFLICT',409);
 const {rows:[reply]}=await db.query('INSERT INTO konektag.review_merchant_replies(review_id,actor_id,content,version) VALUES($1,$2,$3,$4) RETURNING content,version,created_at',[reviewId,actorId,content,Number(version)+1]);return reply;
 });
}
export async function reportReview(actorId:string,reviewId:string,input:Record<string,unknown>){visibilityId(reviewId);
 if(!['SPAM','ABUSE','CONFLICT','OTHER'].includes(String(input.reason)))throw new VisibilityError('REPORT_REASON_REQUIRED');
 const details=visibilityText(input.details??'',2000,false);
 const {rows:[r]}=await pool.query('SELECT id FROM konektag.reviews WHERE id=$1 AND deleted_at IS NULL',[reviewId]);if(!r)throw new VisibilityError('REVIEW_NOT_FOUND',404);
 const {rows:[report]}=await pool.query(`INSERT INTO konektag.review_reports(review_id,reporter_id,reason,details) VALUES($1,$2,$3,$4)
 ON CONFLICT(review_id,reporter_id) DO UPDATE SET reporter_id=EXCLUDED.reporter_id RETURNING id,state`,[reviewId,actorId,input.reason,details]);return report;
}
export async function moderateReview(actorId:string,reviewId:string,input:Record<string,unknown>){visibilityId(reviewId);const reason=visibilityText(input.reason,2000);
 if(!['VISIBLE','HIDDEN'].includes(String(input.state)))throw new VisibilityError('INVALID_MODERATION');
 return visibilityTransaction(async db=>{await visibilityAdmin(actorId,db);
 const {rows:[r]}=await db.query('SELECT merchant_id FROM konektag.reviews WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[reviewId]);if(!r)throw new VisibilityError('REVIEW_NOT_FOUND',404);
 await db.query('SELECT id FROM konektag.merchant_profiles WHERE id=$1 FOR UPDATE',[r.merchant_id]);
 await db.query('INSERT INTO konektag.review_moderation_events(review_id,actor_id,state,reason) VALUES($1,$2,$3,$4)',[reviewId,actorId,input.state,reason]);
 await db.query(`UPDATE konektag.review_reports SET state=$2,resolved_by=$3,resolution_reason=$4,resolved_at=now() WHERE review_id=$1 AND state='OPEN'`,[reviewId,input.state==='HIDDEN'?'HIDDEN':'DISMISSED',actorId,reason]);
 await db.query(`UPDATE konektag.merchant_profiles SET rating=(SELECT round(avg(r.rating)::numeric,1) FROM konektag.reviews r WHERE r.merchant_id=$1 AND r.deleted_at IS NULL AND ${REVIEW_VISIBLE_SQL}),version=version+1 WHERE id=$1`,[r.merchant_id]);return {state:input.state};
 });
}
export async function merchantReviewInbox(actorId:string,merchantId:string){await visibilityManager(actorId,merchantId);const {rows}=await pool.query(`SELECT r.id,r.rating,r.comment,r.created_at,u.username,reply.content AS reply,COALESCE(reply.version,0) AS reply_version,
 ${VERIFIED_CUSTOMER_SQL} AS verified_customer FROM konektag.reviews r LEFT JOIN konektag.users u ON u.id=r.user_id
 LEFT JOIN LATERAL(SELECT content,version FROM konektag.review_merchant_replies WHERE review_id=r.id ORDER BY version DESC LIMIT 1) reply ON true
 WHERE r.merchant_id=$1 AND r.deleted_at IS NULL AND ${REVIEW_VISIBLE_SQL} ORDER BY r.created_at DESC LIMIT 100`,[merchantId]);return {reviews:rows};}
export async function moderationInbox(actorId:string,includeResolved=false){await visibilityAdmin(actorId);const {rows}=await pool.query(`SELECT p.id,p.review_id,p.reason,p.details,p.state,p.resolution_reason,p.created_at,r.comment,r.rating,m.business_name FROM konektag.review_reports p JOIN konektag.reviews r ON r.id=p.review_id JOIN konektag.merchant_profiles m ON m.id=r.merchant_id WHERE ($1::boolean OR p.state='OPEN') ORDER BY (p.state='OPEN') DESC,p.created_at DESC LIMIT 100`,[includeResolved]);return {reports:rows};}
