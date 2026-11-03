import crypto from 'node:crypto';
import { getSiteUrl } from './seo.ts';

const endpoint='https://api.indexnow.org/indexnow';
export function indexNowKey():string{const key=process.env.INDEXNOW_KEY?.trim()||'';return /^[a-zA-Z0-9-]{8,128}$/.test(key)?key:''}
export function indexNowKeyLocation():string{const key=indexNowKey();return key?`${getSiteUrl()}/${key}.txt`:''}
export async function notifyIndexNow(urls:string[]):Promise<{submitted:number;skipped:boolean}>{
  const key=indexNowKey(),host=new URL(getSiteUrl()).host;
  const clean=[...new Set(urls)].filter(u=>{try{const parsed=new URL(u);return parsed.host===host&&parsed.origin===new URL(getSiteUrl()).origin&&!parsed.username&&!parsed.password&&!parsed.hash}catch{return false}});
  if(!key||!clean.length)return {submitted:0,skipped:true};
  const body={host,key,keyLocation:indexNowKeyLocation(),urlList:clean.slice(0,10000)};
  const r=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(10000),redirect:'error',headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify(body)});
  if(!r.ok&&r.status!==202)throw new Error(`INDEXNOW_${r.status}`);
  return {submitted:Math.min(clean.length,10000),skipped:false};
}
export function indexNowEventKey(url:string):string{return crypto.createHash('sha256').update(url).digest('hex')}

