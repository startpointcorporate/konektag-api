import type { PoolClient, QueryResultRow } from 'pg';

interface KSendRecipientDbRow extends QueryResultRow {
  id:string; owner_keycloak_id:string; recipient_user_id:string; full_name:string; is_active:boolean; version:number;
}
export interface KSendRecipientRow extends KSendRecipientDbRow {}

export class KSendBeneficiaryRepository {
  constructor(private readonly client:Pick<PoolClient,'query'>){}
  async create(ownerId:string,input:{recipientUserId:string;fullName:string}):Promise<KSendRecipientRow>{
    const {rows}=await this.client.query<KSendRecipientDbRow>(
      `INSERT INTO konektag.k_send_beneficiaries(owner_keycloak_id,recipient_user_id,full_name,is_active)
       VALUES($1,$2,$3,true)
       ON CONFLICT (owner_keycloak_id,recipient_user_id) WHERE deleted_at IS NULL AND is_active=true
       DO UPDATE SET full_name=EXCLUDED.full_name,updated_at=now(),version=konektag.k_send_beneficiaries.version+1
       RETURNING id,owner_keycloak_id,recipient_user_id,full_name,is_active,version`,
      [ownerId,input.recipientUserId,input.fullName]);
    return rows[0]!;
  }
  async find(id:string,ownerId:string):Promise<KSendRecipientRow|null>{
    const {rows}=await this.client.query<KSendRecipientDbRow>(
      `SELECT id,owner_keycloak_id,recipient_user_id,full_name,is_active,version FROM konektag.k_send_beneficiaries
       WHERE id=$1 AND owner_keycloak_id=$2 AND deleted_at IS NULL AND is_active=true`,[id,ownerId]);
    return rows[0]??null;
  }
  async list(ownerId:string):Promise<KSendRecipientRow[]>{
    const {rows}=await this.client.query<KSendRecipientDbRow>(
      `SELECT id,owner_keycloak_id,recipient_user_id,full_name,is_active,version FROM konektag.k_send_beneficiaries
       WHERE owner_keycloak_id=$1 AND deleted_at IS NULL AND is_active=true ORDER BY updated_at DESC LIMIT 50`,[ownerId]);
    return rows;
  }
  async update(id:string,ownerId:string,input:{fullName?:string}):Promise<KSendRecipientRow>{
    const current=await this.find(id,ownerId);if(!current)throw new Error('K_SEND_RECIPIENT_NOT_FOUND');
    const {rows}=await this.client.query<KSendRecipientDbRow>(
      `UPDATE konektag.k_send_beneficiaries SET full_name=COALESCE($3,full_name),updated_at=now(),version=version+1
       WHERE id=$1 AND owner_keycloak_id=$2 AND version=$4 AND deleted_at IS NULL RETURNING id,owner_keycloak_id,recipient_user_id,full_name,is_active,version`,
      [id,ownerId,input.fullName,current.version]);if(!rows[0])throw new Error('K_SEND_RECIPIENT_CONFLICT');return rows[0];
  }
  async remove(id:string,ownerId:string):Promise<void>{const current=await this.find(id,ownerId);if(!current)throw new Error('K_SEND_RECIPIENT_NOT_FOUND');
    const {rows}=await this.client.query(`UPDATE konektag.k_send_beneficiaries SET is_active=false,deleted_at=now(),updated_at=now(),version=version+1 WHERE id=$1 AND owner_keycloak_id=$2 AND version=$3 RETURNING id`,[id,ownerId,current.version]);
    if(!rows[0])throw new Error('K_SEND_RECIPIENT_CONFLICT');}
}
