export type CountryCurrency = { code: string; name: string; currency: string };

const COUNTRIES: readonly CountryCurrency[] = [
  ['FR','France','EUR'],['LB','Liban','USD'],['BJ','Bénin','XOF'],['BF','Burkina Faso','XOF'],['CM','Cameroun','XAF'],
  ['CG','Congo-Brazzaville','XAF'],['CD','RDC','CDF'],['ET','Éthiopie','ETB'],['GA','Gabon','XAF'],
  ['GH','Ghana','GHS'],['CI',"Côte d'Ivoire",'XOF'],['KE','Kenya','KES'],['LS','Lesotho','LSL'],
  ['MW','Malawi','MWK'],['ML','Mali','XOF'],['NG','Nigeria','NGN'],['RW','Rwanda','RWF'],
  ['SN','Sénégal','XOF'],['SL','Sierra Leone','SLL'],['TZ','Tanzanie','TZS'],['TG','Togo','XOF'],
  ['UG','Ouganda','UGX'],['ZM','Zambie','ZMW'],['AO','Angola','AOA'],['TD','Tchad','XAF'],
  ['GN','Guinée','GNF'],['CF','République Centrafricaine','XAF'],['GQ','Guinée Équatoriale','XAF'],
].map(([code,name,currency])=>({code,name,currency}));

const aliases: Record<string,string> = {
  congo:'CG','congo brazzaville':'CG','congo-brazzaville':'CG','république du congo':'CG','republique du congo':'CG',
  rdc:'CD','rd congo':'CD','république démocratique du congo':'CD','republique democratique du congo':'CD',
  france:'FR','angola':'AO','cameroun':'CM',"côte d'ivoire":'CI',"cote d'ivoire":'CI','sénégal':'SN','senegal':'SN',
};

const norm=(v:string)=>v.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const byCode=new Map(COUNTRIES.map(c=>[c.code,c]));
const byName=new Map(COUNTRIES.map(c=>[norm(c.name),c]));

export function countryCurrency(country: unknown): CountryCurrency {
  const raw=typeof country==='string'?country.trim():'';
  if(!raw) throw new Error('COUNTRY_REQUIRED');
  const upper=raw.toUpperCase();
  let found=byCode.get(upper) || byName.get(norm(raw));
  if(!found){const alias=aliases[norm(raw)];if(alias)found=byCode.get(alias);}
  if(!found) throw new Error('COUNTRY_UNSUPPORTED');
  return found;
}
export function currencyForMerchantCountry(country: unknown): string { return countryCurrency(country).currency; }
export function countryCode(country: unknown): string { return countryCurrency(country).code; }
export const COUNTRY_CURRENCIES=COUNTRIES;
