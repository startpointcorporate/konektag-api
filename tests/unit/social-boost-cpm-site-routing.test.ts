import {describe,expect,it,vi} from 'vitest';
vi.mock('../../src/infrastructure/database/pool.ts',()=>({default:{query:vi.fn()}}));
import {boostBillingFrappeSite} from '../../src/application/services/merchant-social-boost-price-resolver.ts';

const companies={
  FR:{company:'Konektag France',site:'EUROPE',host:'fr.example.test'},
  CG:{company:'Konektag Congo',site:'KONEKTAG_CG',host:'cg.example.test'},
  LB:{company:'Konektag Liban',site:'LIBAN',host:'lb.example.test'},
} as const;

const env={
  MARKETPLACE_TRANSACTION_MERCHANTS:JSON.stringify({
    'konektag-fr':{site:'EUROPE'},'konektag-cg':{site:'KONEKTAG_CG'},'konektag-lb':{site:'LIBAN'},
  }),
  ...Object.fromEntries(Object.values(companies).flatMap(({site,host})=>[
    [`MARKETPLACE_FRAPPE_${site}_URL`,`https://${host}/`],
    [`MARKETPLACE_FRAPPE_${site}_API_KEY`,`${site}-key`],
    [`MARKETPLACE_FRAPPE_${site}_API_SECRET`,`${site}-secret`],
  ])),
} as NodeJS.ProcessEnv;

function database(country:keyof typeof companies,{mapping=true}={}){
  const {company}=companies[country];
  return {query:vi.fn(async(sql:string)=>({rows:sql.includes('SELECT DISTINCT billing_company')
    ?[{company,country_code:country}]
    :mapping?[{payment_country:country}]:[]}))};
}

describe('CPM billing-site routing with the real allowlisted Frappe client',()=>{
  it.each(Object.keys(companies) as Array<keyof typeof companies>)(
    'routes %s billing to a distinct configured host',async country=>{
      const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({data:{name:'Item'}}),{
        status:200,headers:{'content-type':'application/json'},
      }));
      const site=await boostBillingFrappeSite(companies[country].company,database(country),{env,fetchImpl:fetchImpl as typeof fetch});
      await site.get('Item','KTG-BOOST-FACEBOOK-'+country);
      expect(site.key).toBe(companies[country].site);
      expect(site.host).toBe(companies[country].host);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String((fetchImpl.mock.calls as unknown[][])[0][0])).toMatch(new RegExp(`^https://${companies[country].host}/api/resource/Item/`));
    },
  );

  it('fails closed when the billing country has no active payment-site mapping',async()=>{
    const fetchImpl=vi.fn();
    await expect(boostBillingFrappeSite(companies.FR.company,database('FR',{mapping:false}),{env,fetchImpl:fetchImpl as typeof fetch}))
      .rejects.toThrow('BOOST_ERP_SITE_UNAVAILABLE');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not retry another host when the selected site rejects its credentials',async()=>{
    const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({exc_type:'PermissionError'}),{
      status:403,headers:{'content-type':'application/json'},
    }));
    const site=await boostBillingFrappeSite(companies.CG.company,database('CG'),{env,fetchImpl:fetchImpl as typeof fetch});
    await expect(site.get('Item','KTG-BOOST-FACEBOOK-CG')).rejects.toMatchObject({code:'SITE_REJECTED',httpStatus:403});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls as unknown[][])[0][0])).toContain(`https://${companies.CG.host}/`);
  });
});
