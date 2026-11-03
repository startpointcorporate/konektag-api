import type {RouteHandler} from '../../http';
import {qrService,QRValidationError} from '../../../application/services/qr-service.ts';
export const GET:RouteHandler=async({locals,url})=>{
 if(!locals.user)return Response.json({error:'UNAUTHORIZED'},{status:401});
 try{const code=url.searchParams.get('code')||'';const qr=await qrService.getQRByShortCode(code);const raw=typeof qr.qr_data==='string'?JSON.parse(qr.qr_data):qr.qr_data;return Response.json({signedQrToken:raw?.signedQrToken,shortCode:qr.short_code});}
 catch(e){return Response.json({error:e instanceof QRValidationError?e.message:'QR_LOOKUP_FAILED'},{status:e instanceof QRValidationError?404:500});}
};
