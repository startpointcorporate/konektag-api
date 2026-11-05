/** Indicative advertising impressions at the final commercial CPM (service fees included).
 * No performance guarantee: impressions are not unique reach or conversions.
 */
export function calculateCpmImpressions(budget:number,cpmLow:number,cpmHigh:number){
  if(!Number.isSafeInteger(budget)||budget<=0||!Number.isFinite(cpmLow)||!Number.isFinite(cpmHigh)
    ||cpmLow<=0||cpmHigh<cpmLow)throw Error('CPM_INVALID_ESTIMATE_INPUT');
  const min=Math.floor(budget*1000/cpmHigh);
  const max=Math.floor(budget*1000/cpmLow);
  if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||min<0||max<min)
    throw Error('CPM_ESTIMATE_OVERFLOW');
  return {min,max};
}
