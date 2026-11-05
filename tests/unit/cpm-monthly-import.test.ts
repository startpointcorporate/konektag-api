import {describe,it,expect} from "vitest";
import {validateMonthlyFile} from "../../src/infrastructure/scripts/jobs/cpm-monthly-import.ts";

const row={billingCompany:"Konektag Congo",targetCountry:"CG",countryName:"Congo",
  network:"facebook",currency:"XAF",cpmLow:1000,cpmHigh:1500};
describe("monthly company/country/network CPM JSON",()=>{
 it("accepts one auditable month with explicit social network range",()=>{
  expect(validateMonthlyFile({month:"2026-11",rates:[row]})).toEqual({month:"2026-11",rates:[row]});
 });
 it("requires the range to be positive and ordered",()=>{
  expect(()=>validateMonthlyFile({month:"2026-11",rates:[{...row,cpmLow:1501}]})).toThrow("CPM_RATE_INVALID");
  expect(()=>validateMonthlyFile({month:"2026-11",rates:[{...row,cpmLow:0}]})).toThrow("CPM_RATE_INVALID");
 });
 it("allows different networks in one country only with same company",()=>{
  const other={...row,network:"instagram",cpmLow:1800,cpmHigh:2300};
  expect(validateMonthlyFile({month:"2026-11",rates:[row,other]}).rates).toHaveLength(2);
  expect(()=>validateMonthlyFile({month:"2026-11",rates:[row,{...other,billingCompany:"Konektag Europe"}]})).toThrow("CPM_MARKET_OWNER_CONFLICT");
 });
 it("rejects duplicates and invalid networks without selecting arbitrary prices",()=>{
  expect(()=>validateMonthlyFile({month:"2026-11",rates:[row,row]})).toThrow("CPM_DUPLICATE_COUNTRY_NETWORK");
  expect(()=>validateMonthlyFile({month:"2026-11",rates:[{...row,network:"linkedin"}]})).toThrow("CPM_RATE_INVALID");
  expect(()=>validateMonthlyFile({month:"2026-13",rates:[row]})).toThrow("CPM_MONTH_INVALID");
 });
 it("rejects unknown keys to prevent accidental extra charges",()=>{
  expect(()=>validateMonthlyFile({month:"2026-11",rates:[{...row,markupPercent:20}]})).toThrow("CPM_RATE_FIELDS_INVALID");
 });
});
