import type { RouteHandler } from '../http';

const DIRECTUS_URL = process.env.PUBLIC_DIRECTUS_URL || 'http://localhost:8056';
const DIRECTUS_EMAIL = process.env.DIRECTUS_ADMIN_EMAIL || 'admin@konektag.app';
const DIRECTUS_PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD || '';

interface Country {
  id: number;
  code: string;
  name: string;
  flag: string;
  currency: string;
  operators: { name: string; code: string; available: boolean }[] | null;
  crypto_wallet: Record<string, string> | null;
  recharge_phone: string | null;
  is_active: boolean;
}

let _cache: { data: Country[]; ts: number } | null = null;
let _directusToken: string | null = null;
let _tokenExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getDirectusToken(): Promise<string> {
  if (_directusToken && Date.now() < _tokenExpiry) return _directusToken;
  const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DIRECTUS_EMAIL, password: DIRECTUS_PASSWORD }),
  });
  const json = await res.json() as any;
  _directusToken = json.data?.access_token || '';
  _tokenExpiry = Date.now() + 10 * 60 * 1000;
  return _directusToken ?? '';
}

const FALLBACK_COUNTRIES: Country[] = [
  { id: 0, code: 'FR', name: 'France', flag: '🇫🇷', currency: 'EUR', operators: [], crypto_wallet: null, recharge_phone: '', is_active: true },
  { id: 1, code: 'BJ', name: 'Bénin', flag: '🇧🇯', currency: 'XOF', operators: [{name:'MTN',code:'MTN',available:true},{name:'MOOV',code:'MOOV',available:true}], crypto_wallet: null, recharge_phone: '+229 01 00 00 00', is_active: true },
  { id: 2, code: 'BF', name: 'Burkina Faso', flag: '🇧🇫', currency: 'XOF', operators: [{name:'Moov',code:'Moov',available:true},{name:'Orange',code:'Orange',available:true}], crypto_wallet: null, recharge_phone: '+226 70 00 00 00', is_active: true },
  { id: 3, code: 'CM', name: 'Cameroun', flag: '🇨🇲', currency: 'XAF', operators: [{name:'MTN',code:'MTN',available:true},{name:'ORANGE',code:'ORANGE',available:true}], crypto_wallet: null, recharge_phone: '+237 6 00 00 00 00', is_active: true },
  { id: 4, code: 'CG', name: 'Congo-Brazzaville', flag: '🇨🇬', currency: 'XAF', operators: [{name:'Airtel',code:'Airtel',available:true},{name:'MTN',code:'MTN',available:true}], crypto_wallet: null, recharge_phone: '+242 06 123 45 67', is_active: true },
  { id: 5, code: 'CD', name: 'RDC', flag: '🇨🇩', currency: 'CDF', operators: [{name:'AIRTEL',code:'AIRTEL',available:true},{name:'ORANGE',code:'ORANGE',available:true},{name:'VODACOM',code:'VODACOM',available:true}], crypto_wallet: null, recharge_phone: '+243 81 000 00 00', is_active: true },
  { id: 6, code: 'ET', name: 'Éthiopie', flag: '🇪🇹', currency: 'ETB', operators: [{name:'Safaricom MPesa',code:'SAFARICOM',available:true},{name:'Ethio telecom',code:'ETHIO',available:true}], crypto_wallet: null, recharge_phone: '', is_active: true },
  { id: 7, code: 'GA', name: 'Gabon', flag: '🇬🇦', currency: 'XAF', operators: [{name:'Airtel',code:'Airtel',available:true}], crypto_wallet: null, recharge_phone: '+241 07 00 00 00', is_active: true },
  { id: 8, code: 'GH', name: 'Ghana', flag: '🇬🇭', currency: 'GHS', operators: [{name:'AT',code:'AT',available:true},{name:'MTN',code:'MTN',available:true},{name:'Telecel',code:'Telecel',available:true}], crypto_wallet: null, recharge_phone: '+233 00 000 0000', is_active: true },
  { id: 9, code: 'CI', name: "Côte d'Ivoire", flag: '🇨🇮', currency: 'XOF', operators: [{name:'MTN',code:'MTN',available:true},{name:'ORANGE',code:'ORANGE',available:true},{name:'Wave',code:'Wave',available:true}], crypto_wallet: null, recharge_phone: '+225 01 02 03 04', is_active: true },
  { id: 10, code: 'KE', name: 'Kenya', flag: '🇰🇪', currency: 'KES', operators: [{name:'M-PESA',code:'MPESA',available:true}], crypto_wallet: null, recharge_phone: '+254 00 000 0000', is_active: true },
  { id: 11, code: 'LS', name: 'Lesotho', flag: '🇱🇸', currency: 'LSL', operators: [{name:'M-PESA',code:'MPESA',available:true}], crypto_wallet: null, recharge_phone: '+266 00 000 0000', is_active: true },
  { id: 12, code: 'MW', name: 'Malawi', flag: '🇲🇼', currency: 'MWK', operators: [{name:'AIRTEL',code:'AIRTEL',available:true},{name:'TNM',code:'TNM',available:true}], crypto_wallet: null, recharge_phone: '+265 00 000 0000', is_active: true },
  { id: 13, code: 'ML', name: 'Mali', flag: '🇲🇱', currency: 'XOF', operators: [{name:'Orange',code:'Orange',available:true},{name:'Moov',code:'Moov',available:true}], crypto_wallet: null, recharge_phone: '+223 70 00 00 00', is_active: true },
  { id: 14, code: 'NG', name: 'Nigeria', flag: '🇳🇬', currency: 'NGN', operators: [{name:'Airtel',code:'Airtel',available:true},{name:'MTN MoMo',code:'MTN',available:true}], crypto_wallet: null, recharge_phone: '+234 00 000 0000', is_active: true },
  { id: 15, code: 'RW', name: 'Rwanda', flag: '🇷🇼', currency: 'RWF', operators: [{name:'MTN',code:'MTN',available:true},{name:'Airtel',code:'Airtel',available:true}], crypto_wallet: null, recharge_phone: '+250 00 000 0000', is_active: true },
  { id: 16, code: 'SN', name: 'Sénégal', flag: '🇸🇳', currency: 'XOF', operators: [{name:'YAS',code:'YAS',available:true},{name:'ORANGE',code:'ORANGE',available:true},{name:'Wave',code:'Wave',available:true}], crypto_wallet: null, recharge_phone: '+221 77 000 00 00', is_active: true },
  { id: 17, code: 'SL', name: 'Sierra Leone', flag: '🇸🇱', currency: 'SLL', operators: [{name:'Orange',code:'Orange',available:true}], crypto_wallet: null, recharge_phone: '+232 00 000 0000', is_active: true },
  { id: 18, code: 'TZ', name: 'Tanzanie', flag: '🇹🇿', currency: 'TZS', operators: [{name:'YAS',code:'YAS',available:true},{name:'AIRTEL',code:'AIRTEL',available:true},{name:'HALOTEL',code:'HALOTEL',available:true},{name:'VODACOM',code:'VODACOM',available:true}], crypto_wallet: null, recharge_phone: '+255 00 000 0000', is_active: true },
  { id: 19, code: 'TG', name: 'Togo', flag: '🇹🇬', currency: 'XOF', operators: [{name:'Togocom',code:'Togocom',available:true},{name:'Moov',code:'Moov',available:true}], crypto_wallet: null, recharge_phone: '+228 90 00 00 00', is_active: true },
  { id: 20, code: 'UG', name: 'Ouganda', flag: '🇺🇬', currency: 'UGX', operators: [{name:'MTN',code:'MTN',available:true},{name:'AIRTEL',code:'AIRTEL',available:true}], crypto_wallet: null, recharge_phone: '+256 00 000 0000', is_active: true },
  { id: 21, code: 'ZM', name: 'Zambie', flag: '🇿🇲', currency: 'ZMW', operators: [{name:'Airtel',code:'Airtel',available:true},{name:'MTN',code:'MTN',available:true},{name:'Zamtel',code:'Zamtel',available:true}], crypto_wallet: null, recharge_phone: '+260 00 000 0000', is_active: true },
  { id: 22, code: 'AO', name: 'Angola', flag: '🇦🇴', currency: 'AOA', operators: [{name:'Unitel',code:'Unitel',available:true},{name:'Movicel',code:'Movicel',available:true}], crypto_wallet: null, recharge_phone: '+244 923 456 789', is_active: true },
  { id: 23, code: 'TD', name: 'Tchad', flag: '🇹🇩', currency: 'XAF', operators: [{name:'Airtel',code:'Airtel',available:true},{name:'Tigo',code:'Tigo',available:true}], crypto_wallet: null, recharge_phone: '+235 66 00 00 00', is_active: true },
  { id: 24, code: 'GN', name: 'Guinée', flag: '🇬🇳', currency: 'GNF', operators: [{name:'Orange',code:'Orange',available:true},{name:'MTN',code:'MTN',available:true}], crypto_wallet: null, recharge_phone: '+224 62 000 00 00', is_active: true },
  { id: 25, code: 'CF', name: 'République Centrafricaine', flag: '🇨🇫', currency: 'XAF', operators: [{name:'Orange',code:'Orange',available:true},{name:'Moov',code:'Moov',available:true},{name:'Airtel',code:'Airtel',available:true}], crypto_wallet: null, recharge_phone: '+236 75 00 00 00', is_active: true },
  { id: 26, code: 'GQ', name: 'Guinée Équatoriale', flag: '🇬🇶', currency: 'XAF', operators: [{name:'Muni',code:'Muni',available:true},{name:'GETESA',code:'GETESA',available:true}], crypto_wallet: null, recharge_phone: '+240 222 000 000', is_active: true },
];


export const GET: RouteHandler = async () => {
  try {
    if (_cache && Date.now() - _cache.ts < CACHE_TTL) {
      return new Response(JSON.stringify(_cache.data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const token = await getDirectusToken();
    const res = await fetch(`${DIRECTUS_URL}/items/countries?sort=sort&filter[is_active][_eq]=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json() as any;
    const raw: any[] = body.data ?? [];

const PHONES: Record<string, string> = {
  FR: '', LB: '+961 3 123 456', CG: '+242 06 123 45 67', AO: '+244 923 456 789',
};

    const countries: Country[] = raw.map((c: any) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      flag: c.flag || '',
      currency: c.currency,
      operators: typeof c.operators === 'string' ? JSON.parse(c.operators) : (c.operators || []),
      crypto_wallet: (() => {
        if (!c.crypto_wallet) return null;
        if (typeof c.crypto_wallet === 'string') {
          try { return JSON.parse(c.crypto_wallet); } catch { return null; }
        }
        return c.crypto_wallet;
      })(),
      recharge_phone: c.recharge_phone || PHONES[c.code] || null,
      is_active: c.is_active !== false,
    }));

    const result = countries.length > 0 ? countries : FALLBACK_COUNTRIES;

    _cache = { data: result, ts: Date.now() };
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify(FALLBACK_COUNTRIES), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
};
