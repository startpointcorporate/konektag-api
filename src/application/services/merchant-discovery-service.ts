import pool from '../../infrastructure/database/pool.ts';
import {indexNowKey,indexNowKeyLocation,notifyIndexNow} from '../shared/indexnow.ts';
import {annotateSearchObservation} from '../shared/search-observation.ts';
export {annotateSearchObservation} from '../shared/search-observation.ts';
import {VisibilityError,visibilityText,visibilityAdmin,visibilityManager,publishedMerchant,publicSite} from './visibility-shared.ts';
export function searchSource(engine:string,value:unknown){
 let u:URL;
 try{u=new URL(visibilityText(value,2000));}catch{throw new VisibilityError('SEARCH_CONSOLE_SOURCE_REQUIRED');}
 const origin=engine==='GOOGLE'?'https://search.google.com':'https://www.bing.com';
 const path=engine==='GOOGLE'?'/search-console':'/webmasters';
 if(u.origin!==origin||u.username||u.password||!(u.pathname===path||u.pathname.startsWith(path+'/')))throw new VisibilityError('SEARCH_CONSOLE_SOURCE_REQUIRED');
 return u.href;
}
export async function discoveryStatus(actor:string,merchantId:string,admin=false){if(admin)await visibilityAdmin(actor);else await visibilityManager(actor,merchantId);
 const merchant=await publishedMerchant(merchantId),key=indexNowKey();
 const {rows:observations}=await pool.query('SELECT DISTINCT ON(engine) engine,result,inspected_url,source_url,observed_at,created_at FROM konektag.merchant_search_observations WHERE merchant_profile_id=$1 AND inspected_url=$2 AND observed_at<=CURRENT_TIMESTAMP ORDER BY engine,observed_at DESC,created_at DESC',[merchantId,merchant.url]);
 const {rows:attempts}=await pool.query('SELECT state,url,created_at FROM konektag.merchant_indexnow_attempts WHERE merchant_profile_id=$1 ORDER BY created_at DESC LIMIT 10',[merchantId]);
 const annotated=observations.map(o=>annotateSearchObservation(o));
 return {url:merchant.url,indexNow:{configured:!!key,keyLocation:key?indexNowKeyLocation():null,attempts},observations:annotated,
 engines:[{id:'GOOGLE',consoleUrl:'https://search.google.com/search-console',status:annotated.find(o=>o.engine==='GOOGLE')||null},{id:'BING',consoleUrl:'https://www.bing.com/webmasters',status:annotated.find(o=>o.engine==='BING')||null}],
 notice:'Les observations Google/Bing sont saisies par un administrateur à partir de leurs consoles, avec date et source. Une soumission IndexNow ne prouve ni l’indexation ni un classement ; elle ne constitue pas une soumission à Google.'};
}
export async function submitMerchantIndexNow(actor:string,merchantId:string){await visibilityAdmin(actor);const merchant=await publishedMerchant(merchantId);let state='FAILED';
 try{const key=indexNowKey();if(!key)throw new VisibilityError('INDEXNOW_NOT_CONFIGURED',503);
 const response=await fetch(indexNowKeyLocation(),{redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok||(await response.text()).trim()!==key)throw new VisibilityError('INDEXNOW_KEY_FILE_NOT_VERIFIED',503);
 const result=await notifyIndexNow([merchant.url]);state=result.skipped?'SKIPPED':'SUBMITTED';return {state,url:merchant.url};
 }finally{await pool.query('INSERT INTO konektag.merchant_indexnow_attempts(merchant_profile_id,actor_id,url,state) VALUES($1,$2,$3,$4)',[merchantId,actor,merchant.url,state]);}
}
export async function recordSearchObservation(actor:string,merchantId:string,input:Record<string,unknown>){await visibilityAdmin(actor);const merchant=await publishedMerchant(merchantId),engine=String(input.engine),result=String(input.result);
 if(!['GOOGLE','BING'].includes(engine)||!['INDEXED','NOT_INDEXED','UNKNOWN'].includes(result))throw new VisibilityError('INVALID_SEARCH_OBSERVATION');
 const source=searchSource(engine,input.sourceUrl),at=new Date(String(input.observedAt));if(!Number.isFinite(at.getTime())||at.getTime()>Date.now())throw new VisibilityError('INVALID_OBSERVATION_DATE');
 const {rows:[row]}=await pool.query(`INSERT INTO konektag.merchant_search_observations(merchant_profile_id,actor_id,engine,result,inspected_url,source_url,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[merchantId,actor,engine,result,merchant.url,source,at]);return row;
}
