export type AmountUnit = 'MAJOR' | 'MINOR';

/** Shared PRO-01 minor-unit representation used by business and checkout. */
export interface Money { amountMinor: number; currency: string }

export function assertMoney(value: Money): void {
    minorDigits(value.currency);
    if (!Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0) {
        throw new Error('amountMinor must be a non-negative safe integer');
    }
}

const MINOR_DIGITS: Record<string, number> = { EUR: 2, XOF: 0, XAF: 0, USD: 2, LBP: 2, AOA: 2, CDF: 2, GNF: 0, ETB: 2, GHS: 2, KES: 2, LSL: 2, MWK: 2, NGN: 2, RWF: 0, SLL: 2, TZS: 2, UGX: 0, ZMW: 2 };

export function minorDigits(currency: string): number {
    const digits = MINOR_DIGITS[currency];
    if (digits === undefined) throw new Error(`unsupported minor-unit currency: ${currency}`);
    return digits;
}

export function decimalRatio(value: string): { numerator: bigint; denominator: bigint } {
    if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('invalid positive decimal rate');
    const [whole, fraction = ''] = value.split('.');
    const denominator = 10n ** BigInt(fraction.length);
    const numerator = BigInt(whole) * denominator + BigInt(fraction || '0');
    if (numerator <= 0n) throw new Error('invalid positive decimal rate');
    return { numerator, denominator };
}

export function convertEurMinor(amountMinor: number, targetCurrency: string, rate: string, inverse = false): number {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('invalid EUR minor amount');
    const digits = minorDigits(targetCurrency);
    const { numerator, denominator } = decimalRatio(rate);
    const scale = 10n ** BigInt(digits);
    const top = BigInt(amountMinor) * scale * (inverse ? denominator : numerator);
    const bottom = 100n * (inverse ? numerator : denominator);
    const rounded = (top + bottom / 2n) / bottom;
    if (rounded <= 0n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('converted amount out of range');
    return Number(rounded);
}

export function convertMinor(amountMinor: number, sourceCurrency: string, targetCurrency: string,
    rate: string, inverse = false): number {
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error('invalid minor amount');
    const { numerator, denominator } = decimalRatio(rate);
    const top = BigInt(amountMinor) * 10n ** BigInt(minorDigits(targetCurrency)) * (inverse ? denominator : numerator);
    const bottom = 10n ** BigInt(minorDigits(sourceCurrency)) * (inverse ? numerator : denominator);
    const rounded = (top + bottom / 2n) / bottom;
    if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('converted amount out of range');
    return Number(rounded);
}

export function minorDecimal(amountMinor: number, currency: string): string {
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error('invalid minor amount');
    const digits = minorDigits(currency);
    if (!digits) return String(amountMinor);
    const scale = 10 ** digits;
    return `${Math.floor(amountMinor / scale)}.${String(amountMinor % scale).padStart(digits, '0')}`;
}

/** Inverse of minorDecimal: a major-unit decimal entered by a person, in the currency's minor units. */
export function majorToMinor(amount: string, currency: string): number {
    const digits = minorDigits(currency);
    const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
    if (!match || (match[2]?.length ?? 0) > digits) throw new Error('AMOUNT_PRECISION_INVALID');
    const minor = Number(match[1] + (match[2] ?? '').padEnd(digits, '0'));
    if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error('AMOUNT_PRECISION_INVALID');
    return minor;
}

export function formatMinor(amountMinor: number, currency: string): string {
    const [whole, fraction] = minorDecimal(amountMinor, currency).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return fraction === undefined ? grouped : `${grouped},${fraction}`;
}

export function toProviderMinor(amount: number, currency: string, unit: AmountUnit): number {
    if (!Number.isSafeInteger(amount)) {
        throw new Error('amount must be a safe integer');
    }
    if (amount < 0) {
        throw new Error('amount must be non-negative');
    }

    if (unit === 'MINOR') {
        if (currency !== 'EUR') {
            throw new Error(`unsupported currency for MINOR provider: ${currency}`);
        }
        return amount;
    }

    if (unit === 'MAJOR') {
        switch (currency) {
            case 'EUR':
                if (!Number.isSafeInteger(amount * 100)) throw new Error('amount exceeds safe minor-unit range');
                return amount * 100;
            case 'XOF':
                return amount;
            default:
                throw new Error(`unsupported currency for MAJOR provider: ${currency}`);
        }
    }

    throw new Error(`invalid AmountUnit: ${unit}`);
}

export function formatEurMinor(amountMinor: number): string {
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
        throw new Error('amountMinor must be a non-negative safe integer');
    }
    const integerPart = Math.floor(amountMinor / 100);
    const remainder = amountMinor % 100;
    const integerStr = integerPart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const remainderStr = remainder.toString().padStart(2, '0');
    return `${integerStr},${remainderStr} EUR`;
}

