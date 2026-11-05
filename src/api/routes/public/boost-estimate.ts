import type {RouteHandler} from "../../http";
import {GET as getCpmCatalog} from "./boost-cpm.ts";
import {calculateCpmImpressions} from "../../../application/services/cpm-estimate.ts";

// Budget is a positive integer in the market's CPM currency, including Konektag
// service fees. The server resolves the market owner; clients cannot supply it.
export const POST:RouteHandler=async context=>{
  let data:Record<string,unknown>;
  try{
    const raw=await context.request.text();
    if(raw.length>4096)return Response.json({error:"INVALID_CPM_REQUEST"},{status:400});
    data=JSON.parse(raw);
    if(!data||typeof data!=="object"||Array.isArray(data)
      ||Object.keys(data).some(k=>!["targetCountry","network","budget","currency"].includes(k)))
      return Response.json({error:"INVALID_CPM_REQUEST"},{status:400});
  }catch{return Response.json({error:"INVALID_CPM_REQUEST"},{status:400});}
  const {targetCountry,network,budget,currency}=data;
  if(typeof targetCountry!=="string"||!/^[A-Z]{2}$/.test(targetCountry)
    ||typeof network!=="string"||!["facebook","instagram","tiktok"].includes(network)
    ||typeof currency!=="string"||!/^[A-Z]{3}$/.test(currency)
    ||typeof budget!=="number"||!Number.isSafeInteger(budget)||budget<=0)
    return Response.json({error:"INVALID_CPM_REQUEST"},{status:400});
  const catalogResponse=await getCpmCatalog(context);
  if(!catalogResponse.ok)return catalogResponse;
  const catalog=await catalogResponse.json() as {countries:Array<{
    code:string;billingCompany:string;channels:Array<{
      channel:string;currency:string;cpmLow:number;cpmHigh:number;referenceMonth:string;stale:boolean
    }>
  }>};
  const country=catalog.countries.find(c=>c.code===targetCountry);
  const rate=country?.channels.find(c=>c.channel===network);
  if(!country||!rate)return Response.json({error:"CPM_RATE_NOT_AVAILABLE"},{status:404});
  if(rate.currency!==currency)return Response.json({error:"CPM_CURRENCY_MISMATCH"},{status:422});
  try{
    return Response.json({targetCountry,network,billingCompany:country.billingCompany,
      budget,currency,estimatedImpressions:calculateCpmImpressions(budget,rate.cpmLow,rate.cpmHigh),
      referenceMonth:rate.referenceMonth,stale:rate.stale,estimated:true,guaranteed:false},
      {headers:{"Cache-Control":"no-store"}});
  }catch{return Response.json({error:"INVALID_CPM_REQUEST"},{status:400});}
};
