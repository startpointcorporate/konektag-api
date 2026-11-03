import type { RouteHandler } from '../../../../../http';
import { kSendService } from '../../../../../../application/services/k-send-application-service.ts';
export const GET:RouteHandler=async({params,locals})=>{const u=locals.user;if(!u)return new Response(null,{status:401});const recipient=await kSendService.getRecipient(params.id!,u.keycloak_id);if(!recipient)return new Response(null,{status:404});return new Response(JSON.stringify(kSendService.recipientQr(recipient.id, recipient.recipient_user_id)),{headers:{'Content-Type':'application/json'}});};
