import type {RouteHandler} from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

/** Neighborhood suggestions from published merchant profiles in the same city and country. */
export const GET:RouteHandler=async ({url})=>{
  const country=(url.searchParams.get('country')||'').trim().slice(0,100);
  const city=(url.searchParams.get('city')||'').trim().slice(0,100);
  const query=(url.searchParams.get('q')||'').trim().slice(0,80);
  if(!country||!city)return new Response(JSON.stringify({suggestions:[]}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  try{
    const {rows}=await pool.query(`
      SELECT trim(m.neighborhood) AS name, count(*)::int AS uses
      FROM konektag.merchant_profiles m
      JOIN konektag.cities c ON c.id=m.city_id
      WHERE c.country_code=konektag.city_country_code($1)
        AND lower(c.normalized_name)=lower($2)
        AND m.status IN ('Published','Referenced')
        AND m.deleted_at IS NULL
        AND nullif(trim(m.neighborhood),'') IS NOT NULL
        AND ($3='' OR m.neighborhood ILIKE '%' || replace(replace(replace($3,'!','!!'),'%','!%'),'_','!_') || '%' ESCAPE '!')
      GROUP BY lower(trim(m.neighborhood)),trim(m.neighborhood)
      ORDER BY uses DESC,name ASC LIMIT 12`,[country,city,query]);
    return new Response(JSON.stringify({suggestions:rows.map(r=>r.name)}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }catch{
    return new Response(JSON.stringify({suggestions:[],unavailable:true}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }
};
