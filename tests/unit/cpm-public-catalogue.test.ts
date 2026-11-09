import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("../../src/infrastructure/database/pool.ts",()=>({default:{query:mocks.query}}));
import {GET} from "../../src/api/routes/public/boost-cpm.ts";
const row=(channel:string,code:string,name:string,company:string,site:string,currency:string,low:number,high:number)=>({
 channel,code,name,billingCompany:company,erpnextSite:site,itemCode:`KTG-BOOST-${channel.toUpperCase()}-${code}`,
 currency,cpmLow:low,cpmHigh:high,referenceMonth:"2026-11",ageMonths:0
});
const data=[
 row("facebook","CG","Congo","Konektag Congo","congo.erp.konektag.eu","XAF",600,2400),
 row("instagram","CG","Congo","Konektag Congo","congo.erp.konektag.eu","XAF",960,3600),
 row("facebook","FR","France","Konektag Europe","europe.erp.konektag.eu","EUR",7.5,11),
 row("instagram","FR","France","Konektag Europe","europe.erp.konektag.eu","EUR",10,14),
 row("tiktok","LB","Liban","Konektag Lebanon","liban.erp.konektag.eu","USD",4.8,10.8)
];
function call(query=""){return GET({url:new URL("https://api.konektag.eu/api/public/boost-cpm"+query)} as any);}
beforeEach(()=>{
 mocks.query.mockReset();
 mocks.query.mockImplementation(async (_sql:string,args:[string|null,string|null])=>({rows:data.filter(x=>
  (!args[0]||x.code===args[0])&&(!args[1]||x.channel===args[1]))}));
});
describe("PostgreSQL-only CPM catalogue",()=>{
 it("groups by country and network without an ERPNext request",async()=>{
  const res=await call();
  const body=await res.json();
  expect(res.status).toBe(200);
  expect(body.countries).toHaveLength(3);
  expect(body.networks.find((n:any)=>n.network==="facebook").targetCountries).toHaveLength(2);
  expect(body.countries[0].channels[0]).toMatchObject({itemCode:"KTG-BOOST-FACEBOOK-CG",erpnextSite:"congo.erp.konektag.eu"});
  expect(mocks.query.mock.calls[0][0]).toContain("konektag.cpm_source_sites");
 });
 it("filters by target country",async()=>{
  const res=await call("?country=FR");
  const body=await res.json();
  expect(body.countries.map((c:any)=>c.code)).toEqual(["FR"]);
  expect(mocks.query.mock.calls[0][1]).toEqual(["FR",null]);
 });
 it("filters by network and exposes network grouping",async()=>{
  const body=await (await call("?network=facebook&groupBy=network")).json();
  expect(body.groupBy).toBe("network");
  expect(body.networks).toHaveLength(1);
  expect(body.networks[0].targetCountries.map((c:any)=>c.code)).toEqual(["CG","FR"]);
  expect(mocks.query.mock.calls[0][1]).toEqual([null,"facebook"]);
 });
 it("rejects invalid filters without querying PostgreSQL",async()=>{
  expect((await call("?country=FRA")).status).toBe(400);
  expect((await call("?network=linkedin")).status).toBe(400);
  expect((await call("?groupBy=unknown")).status).toBe(400);
  expect(mocks.query).not.toHaveBeenCalled();
 });
 it("does not advertise inconsistent rates",async()=>{
  mocks.query.mockResolvedValue({rows:[{...data[0],cpmLow:2500,cpmHigh:2000}]});
  const r=await call();
  expect(r.status).toBe(503);
 });
});
