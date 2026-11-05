import {describe,it,expect,vi} from "vitest";
import {parseAccounts,marketOwner,weightedCpm,observation} from "../../src/application/services/cpm-market-service.ts";

describe("multi-company CPM market ownership",()=>{
  it("rejects ambiguous and absent active target-country owners",async()=>{
    const two={query:vi.fn().mockResolvedValue({rows:[{billing_company:"Konektag Congo"},{billing_company:"Konektag Europe"}]})};
    await expect(marketOwner(two,"CM")).rejects.toThrow("CPM_MARKET_AMBIGUOUS");
    const none={query:vi.fn().mockResolvedValue({rows:[]})};
    await expect(marketOwner(none,"FR")).rejects.toThrow("CPM_MARKET_UNASSIGNED");
  });
  it("routes only by explicit target-country mapping, never by merchant origin",async()=>{
    const congo={query:vi.fn().mockResolvedValue({rows:[{billing_company:"Konektag Congo"}]})};
    expect(await marketOwner(congo,"CM")).toBe("Konektag Congo");
    expect(congo.query).toHaveBeenCalledWith(expect.stringContaining("target_country=$1"),["CM"]);
    const europe={query:vi.fn().mockResolvedValue({rows:[{billing_company:"Konektag Europe"}]})};
    expect(await marketOwner(europe,"FR")).toBe("Konektag Europe");
  });
  it("rejects credentials embedded in config, duplicates and bad token names",()=>{
    expect(()=>parseAccounts(JSON.stringify([{billingCompany:"X",platform:"meta",accountId:"123",tokenEnv:"SECRET",currency:"EUR"}]))).toThrow();
    expect(()=>parseAccounts(JSON.stringify([{billingCompany:"X",platform:"meta",accountId:"123",tokenEnv:"KONEKTAG_CPM_META_X_TOKEN",currency:"EUR"},{billingCompany:"Y",platform:"meta",accountId:"123",tokenEnv:"KONEKTAG_CPM_META_Y_TOKEN",currency:"EUR"}]))).toThrow();
  });
  it("calculates impression-weighted CPM without mixing currencies or promising impressions",()=>{
    expect(weightedCpm([{spend:100,impressions:1000,currency:"EUR"},{spend:400,impressions:9000,currency:"EUR"}])).toEqual({cpm:50,spend:500,impressions:10000,currency:"EUR"});
    expect(weightedCpm([{spend:100,impressions:1000,currency:"EUR"},{spend:200,impressions:1000,currency:"XAF"}])).toBeNull();
    expect(weightedCpm([{spend:10,impressions:100,currency:"EUR"}])).toBeNull();
  });
  it("refuses samples with invalid country, currency or impressions",()=>{
    const base={billingCompany:"Konektag Europe",platform:"facebook" as const,targetCountry:"FR",
      adAccountRef:"a".repeat(64),source:"meta_ads_insights" as const,currency:"EUR",spend:5,impressions:1000,observationDay:"2026-11-04"};
    expect(observation(base)).toEqual(base);
    expect(observation({...base,targetCountry:"ZZZ"})).toBeNull();
    expect(observation({...base,impressions:0})).toBeNull();
  });
});
