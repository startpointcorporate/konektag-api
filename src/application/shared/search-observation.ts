/** Freshness is independent of the manually recorded engine result. */
export function annotateSearchObservation<T extends {observed_at:string|Date}>(observation:T,now=Date.now()):T & {ageDays:number|null;stale:boolean;valid:boolean}{
 const at=new Date(observation.observed_at).getTime();
 const valid=Number.isFinite(at)&&Number.isFinite(now)&&at<=now;
 const elapsed=now-at;
 return {...observation,ageDays:valid?Math.floor(elapsed/86400000):null,stale:!valid||elapsed>30*86400000,valid};
}
