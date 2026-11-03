import {request} from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {VisibilityError} from './visibility-shared.ts';

export function postizBase(value:unknown){
 try{const u=new URL(String(value));if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.port&&u.port!=='443')throw 0;
 return u.href.replace(/\/$/,'').replace(/\/public\/v1$/,'')+'/public/v1';
 }catch{throw new VisibilityError('POSTIZ_URL_INVALID',422);}
}
export function allowedPostizBase(value:unknown){
 const base=postizBase(value),origin=new URL(base).origin;
 const allowed=(process.env.POSTIZ_ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
 // The operator-controlled default origin remains usable for shared accounts.
 if(process.env.POSTIZ_API_URL)allowed.push(new URL(postizBase(process.env.POSTIZ_API_URL)).origin);
 if(!allowed.includes(origin))throw new VisibilityError('POSTIZ_ORIGIN_NOT_ALLOWED',403);
 return base;
}
export function publicPostizAddress(ip:string){
 const family=isIP(ip);
 if(family===4){const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&[0,168].includes(b)||a===100&&b>=64&&b<=127||a===198&&[18,19].includes(b));}
 // Only global unicast IPv6; excludes loopback, ULA, link-local, mapped IPv4 and documentation ranges.
 return family===6&&/^[23][0-9a-f]{3}:/i.test(ip)&&!/^2001:(?:db8|0):/i.test(ip)&&!/^2002:/i.test(ip);
}
/** Pin a verified public DNS result to the TLS request: no redirects or DNS rebinding. */
export async function postizHttp(base:string,key:string,path:string,method='GET',body?:unknown):Promise<any>{
 const url=new URL(base+path);if(!path.startsWith('/')||url.origin!==new URL(base).origin)throw new VisibilityError('POSTIZ_PATH_INVALID');
 let timer:ReturnType<typeof setTimeout>;
 const records=await Promise.race([lookup(url.hostname,{all:true}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new VisibilityError('POSTIZ_DNS_TIMEOUT',503)),5000);})]).finally(()=>clearTimeout(timer!)).catch(e=>{throw e instanceof VisibilityError?e:new VisibilityError('POSTIZ_DNS_FAILED',503);});
 if(!records.length||records.some(r=>!publicPostizAddress(r.address)))throw new VisibilityError('POSTIZ_ADDRESS_NOT_ALLOWED',403);
 const address=records[0],data=body===undefined?undefined:JSON.stringify(body);
 return new Promise((resolve,reject)=>{
 const req=request(url,{method,agent:false,servername:url.hostname,lookup:((_host:any,options:any,cb:any)=>options?.all?cb(null,[address]):cb(null,address.address,address.family)) as any,
 headers:{Authorization:key,'Content-Type':'application/json',...(data?{'Content-Length':Buffer.byteLength(data)}:{})}},res=>{
 const chunks:Buffer[]=[];let bytes=0;
 res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2*1024*1024){req.destroy(new Error('POSTIZ_RESPONSE_TOO_LARGE'));return;}chunks.push(chunk);});
 res.on('error',()=>reject(new VisibilityError('POSTIZ_TRANSPORT_ERROR',502)));
 res.on('end',()=>{const status=res.statusCode||502;if(status<200||status>=300){reject(new VisibilityError('POSTIZ_HTTP_'+status,status>=400&&status<500?422:502));return;}
 const text=Buffer.concat(chunks).toString('utf8');if(!text){resolve(null);return;}try{resolve(JSON.parse(text));}catch{reject(new VisibilityError('POSTIZ_RESPONSE_INVALID',502));}});
 });
 const timeout=setTimeout(()=>req.destroy(new Error('POSTIZ_TIMEOUT')),30000);req.on('close',()=>clearTimeout(timeout));
 req.on('error',()=>reject(new VisibilityError('POSTIZ_TRANSPORT_ERROR',502)));
 if(data)req.write(data);req.end();
 });
}
