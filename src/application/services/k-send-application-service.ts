import type { KSendIntentRow } from '../../infrastructure/repositories/k-send-repository.ts';
import { KSendRepository } from '../../infrastructure/repositories/k-send-repository.ts';
import { KSendBeneficiaryRepository } from '../../infrastructure/repositories/k-send-beneficiary-repository.ts';
import pool from '../../infrastructure/database/pool.ts';
import { ensureKParty, transferKPoints } from './k-points-service.ts';
import { requireUserKycVerified } from './user-kyc-gate-service.ts';
import { emailService } from './resend-service.ts';
import { encryptionService } from '../../infrastructure/adapters/encryption-service.ts';

export interface KSendInput { senderId:string; recipientUserId:string; quantityK:number; }
export interface KSendQuote { quantityK:number; totalK:number; expiresAt:string; }

function quoteFor(quantityK:number):KSendQuote{
 if(!Number.isSafeInteger(quantityK)||quantityK<=0)throw new Error('INVALID_K_SEND_QUANTITY');
 return {quantityK,totalK:quantityK,expiresAt:new Date(Date.now()+5*60_000).toISOString()};
}
function dto(row:KSendIntentRow){
 const quantityK=Number(row.quantity_k);
 return {id:row.id,senderId:row.sender_keycloak_id,recipientUserId:row.recipient_user_id,recipientName:row.recipient_name,
  originCountry:row.origin_country,destinationCountry:row.destination_country,quantityK,totalK:quantityK,status:row.status,
  createdAt:row.created_at,operationId:row.operation_id,
  totalCount:Number((row as KSendIntentRow&{total_count?:number|string}).total_count||0)};
}

export const kSendService={
 async requestQuote(quantityK:number){return quoteFor(quantityK);},
 async create(input:KSendInput){
  const quantityK=Number(input.quantityK);quoteFor(quantityK);
  const {rows:[sender]}=await pool.query<{id:string;keycloak_id:string;country:string|null}>(
   `SELECT id,keycloak_id,country FROM konektag.users WHERE (keycloak_id::text=$1 OR id::text=$1) AND deleted_at IS NULL LIMIT 1`,[input.senderId]);
  const {rows:[recipient]}=await pool.query<{id:string;keycloak_id:string;username:string;country:string|null}>(
   `SELECT id,keycloak_id,username,country FROM konektag.users WHERE id=$1 AND deleted_at IS NULL`,[input.recipientUserId]);
  if(!sender)throw new Error('K_SEND_SENDER_NOT_FOUND');
  if(!recipient)throw new Error('K_SEND_RECIPIENT_NOT_FOUND');
  if(recipient.id===sender.id)throw new Error('K_SEND_TO_SELF_FORBIDDEN');
  const row=await new KSendRepository(pool).createIntent({
   senderUserId:sender.id,senderKeycloakId:sender.keycloak_id,recipientUserId:recipient.id,recipientKeycloakId:recipient.keycloak_id,
   recipientName:recipient.username,originCountry:(sender.country||'XX').trim().toUpperCase(),
   destinationCountry:(recipient.country||'XX').trim().toUpperCase(),quantityK});
  return {send:dto(row),quote:quoteFor(quantityK)};
 },
 async list(senderId:string,status?:string,limit=20,offset=0){return (await new KSendRepository(pool).list(senderId,status,limit,offset)).map(dto);},
 async count(senderId:string,status?:string){return new KSendRepository(pool).count(senderId,status);},
 async get(id:string){const row=await new KSendRepository(pool).findById(id);if(!row)throw new Error('K_SEND_NOT_FOUND');return dto(row);},
 async cancel(id:string){const repository=new KSendRepository(pool);const current=await repository.findById(id);if(!current)throw new Error('K_SEND_NOT_FOUND');
  const cancelled=await repository.cancel(id,current.version);if(!cancelled)throw new Error('K_SEND_CANCEL_CONFLICT');return dto(cancelled);},
 async execute(id:string,authorizationReference:string){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const repository=new KSendRepository(client);
   const intent=await repository.findById(id,true);
   if(!intent)throw new Error('K_SEND_NOT_FOUND');
   if(intent.status==='Funded'){await client.query('COMMIT');return dto(intent);}
   const quantityK=Number(intent.quantity_k);
   if(!['Draft','Quoted','PendingFunding'].includes(intent.status))throw new Error('K_SEND_STATE_CONFLICT');
   if(!authorizationReference)throw new Error('K_SEND_AUTHORIZATION_REQUIRED');
   await requireUserKycVerified(client,intent.sender_user_id);
   await requireUserKycVerified(client,intent.recipient_user_id);
   // Stable upsert order also prevents opposite-direction sends from deadlocking on parties.
   const parties=new Map<string,Awaited<ReturnType<typeof ensureKParty>>>();
   for(const userId of [intent.sender_user_id,intent.recipient_user_id].sort())parties.set(userId,await ensureKParty(client,userId));
   const walletOperationId=await transferKPoints(client,{senderPartyId:parties.get(intent.sender_user_id)!.id,
    recipientPartyId:parties.get(intent.recipient_user_id)!.id,quantityK,operationKey:`k_send:${intent.id}`});
   const completed=await repository.markFunded(intent.id,intent.version,{authorizationReference,walletOperationId,sendDepth:0});
   const eventKey=`k-send-received:${intent.id}`;
   await client.query(`INSERT INTO konektag.notifications(user_id,type,title,body,link,event_key)
    VALUES($1,'k_send',$2,$3,$4,$5) ON CONFLICT(event_key,user_id) DO NOTHING`,
    [intent.recipient_keycloak_id,'K reçus',`Vous avez reçu ${quantityK} K de ${intent.sender_keycloak_id}.`,'/fr/account/',eventKey]);
   await client.query('COMMIT');

   // Email is deliberately post-commit: a delivery failure must never roll back K already transferred.
   try {
    const {rows:[recipientUser]}=await pool.query(`SELECT encrypted_data,locale,username FROM konektag.users WHERE id=$1 AND deleted_at IS NULL`,[intent.recipient_user_id]);
    if(recipientUser?.encrypted_data){
     const pii=JSON.parse(encryptionService.decrypt(recipientUser.encrypted_data));
     if(pii.email) await emailService.send({
      to:pii.email,
      subject:`Vous avez reçu ${quantityK} K`,
      html:`<p>Bonjour ${recipientUser.username||''},</p><p>Vous avez reçu <strong>${quantityK} K</strong> sur votre wallet Konektag.</p><p>Votre solde a été crédité immédiatement.</p>`
     });
    }
   } catch(error){console.error('[k-send] recipient email notification failed',error);}
   return dto(completed);
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
 },
 async saveRecipient(ownerId:string,data:{recipientUserId:string;fullName:string}){if(!data.recipientUserId)throw new Error('K_SEND_RECIPIENT_USER_REQUIRED');return new KSendBeneficiaryRepository(pool).create(ownerId,data);},
 async getRecipient(id:string,ownerId:string){return new KSendBeneficiaryRepository(pool).find(id,ownerId);},
 async listRecipients(ownerId:string){return new KSendBeneficiaryRepository(pool).list(ownerId);},
 async deleteRecipient(id:string,ownerId:string){await new KSendBeneficiaryRepository(pool).remove(id,ownerId);},
 async updateRecipient(id:string,ownerId:string,data:{fullName?:string}){return new KSendBeneficiaryRepository(pool).update(id,ownerId,data);},
 recipientQr(id:string,recipientUserId:string){return {type:'k_send_recipient',id,recipientUserId};},
};
