import type { RouteHandler } from '../../../http';
import { kSendService } from '../../../../application/services/k-send-application-service.ts';
export const POST:RouteHandler=async({request})=>{try{const body=await request.json() as {quantityK?:number};const quantityK=Number(body.quantityK);
 return new Response(JSON.stringify(await kSendService.requestQuote(quantityK)),{headers:{'Content-Type':'application/json'}});
}catch(error){return new Response(JSON.stringify({error:error instanceof Error?error.message:'INVALID_K_SEND_QUANTITY'}),{status:400,headers:{'Content-Type':'application/json'}});}};
