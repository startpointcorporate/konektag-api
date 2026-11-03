import { majorToMinor } from '../application/services/pay/money-unit.ts';
export class CashError extends Error {
  constructor(public readonly code: string, public readonly status = 422) { super(code); }
}
export type CashStatus = 'RECORDED'|'PARTIALLY_REFUNDED'|'REFUNDED'|'CANCELLED';
export type CashContact = { email?:string; firstName?:string; lastName?:string; phone?:string };
export function cashText(value: unknown, max: number): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > max) throw new CashError('CASH_INVALID_TEXT');
  return value.trim() || undefined;
}
export function cashContact(input: Record<string,unknown>): CashContact {
  const email=cashText(input.email,254),firstName=cashText(input.firstName,100),lastName=cashText(input.lastName,100),phone=cashText(input.phone,40);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CashError('CASH_INVALID_EMAIL');
  return {email,firstName,lastName,phone};
}
export function cashAmount(value: unknown, currency: string): number {
  if (typeof value !== 'string') throw new CashError('CASH_AMOUNT_REQUIRED');
  try { return majorToMinor(value.trim().replace(',', '.'),currency); }
  catch { throw new CashError('CASH_AMOUNT_INVALID'); }
}
export function cashKey(value: unknown): string {
  if(typeof value!=='string'||!/^[A-Za-z0-9:_-]{8,128}$/.test(value)) throw new CashError('CASH_IDEMPOTENCY_KEY_REQUIRED',400);
  return value;
}
export function cashUuid(value: unknown): string {
  if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new CashError('CASH_INVALID_ID',400);
  return value;
}
export function cashAdjustment(sale: {status:CashStatus;amountMinor:number;refundedMinor:number;version:number}, kind:unknown, amount:unknown, currency:string, expectedVersion:unknown) {
  if(expectedVersion!==sale.version) throw new CashError('CASH_VERSION_CONFLICT',409);
  if(sale.status==='CANCELLED'||sale.status==='REFUNDED') throw new CashError('CASH_SALE_CLOSED',409);
  if(kind==='CANCEL') {
    if(sale.refundedMinor!==0) throw new CashError('CASH_ALREADY_REFUNDED',409);
    return {amountMinor:sale.amountMinor,refundedMinor:0,status:'CANCELLED' as CashStatus};
  }
  if(kind!=='REFUND') throw new CashError('CASH_INVALID_ADJUSTMENT');
  const amountMinor=cashAmount(amount,currency), refundedMinor=sale.refundedMinor+amountMinor;
  if(!Number.isSafeInteger(refundedMinor)||refundedMinor>sale.amountMinor) throw new CashError('CASH_REFUND_EXCEEDS_BALANCE',409);
  return {amountMinor,refundedMinor,status:(refundedMinor===sale.amountMinor?'REFUNDED':'PARTIALLY_REFUNDED') as CashStatus};
}
