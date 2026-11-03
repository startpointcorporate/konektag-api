import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertProviderConfigurationKey, ProviderConfigurationError } from '../../../infrastructure/adapters/provider-configuration.ts';

export type PaymentMethod = 'card' | 'mobile_money';

export type PaymentContext = {
  country: string;
  legalEntity: { id: string; code: string; legalName: string };
  currency: string;
  providers: Array<{
    regulatoryProfile: { id: string; code: string; rail: string };
    corridor: string;
    regulatedActor: { id: string; code: string; name: string; logoUrl: string | null } | null;
    provider: string;
    providerConfigurationKey: string | null;
    paymentMethod: PaymentMethod;
    fees: { percentageBps: number; fixedAmount: number };
  }>;
};

export type PaymentContextSelection = {
  country: string;
  legalEntityCode: string;
  currency: string;
  regulatoryProfileCode: string;
  rail: string;
  corridor: string;
  regulatedActorCode: string | null;
  provider: string;
  providerConfigurationKey: string | null;
  paymentMethod: PaymentMethod;
  fees: { percentageBps: number; fixedAmount: number };
  expiresAt: string;
};

type FrappeClient = {
  get: (doctype: string, name: string) => Promise<any>;
  list: (doctype: string, filters?: Record<string, unknown>, fields?: string[], limit?: number) => Promise<any[]>;
};

export class PaymentContextResolutionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PaymentContextResolutionError';
  }
}

export class PaymentContextSelectionError extends Error {}

function paymentContextSelectionSecret(): string {
  const secret = process.env.KONEKTAG_INTEGRATION_SECRET;
  if (!secret || secret.trim().length < 32) throw new PaymentContextSelectionError('PAYMENT_CONTEXT_SELECTION_SECRET_UNAVAILABLE');
  return secret;
}

function signSelectionPayload(payload: string): string {
  return createHmac('sha256', paymentContextSelectionSecret()).update(`payment-context-selection:${payload}`).digest('base64url');
}

export function createPaymentContextSelection(selection: Omit<PaymentContextSelection, 'expiresAt'>): string {
  const payload = Buffer.from(JSON.stringify({ ...selection, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() })).toString('base64url');
  return `${payload}.${signSelectionPayload(payload)}`;
}

export function verifyPaymentContextSelection(token: string): PaymentContextSelection {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new PaymentContextSelectionError('PAYMENT_CONTEXT_SELECTION_INVALID');
  const expected = signSelectionPayload(payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new PaymentContextSelectionError('PAYMENT_CONTEXT_SELECTION_INVALID');
  }
  try {
    const selection = JSON.parse(Buffer.from(payload, 'base64url').toString()) as PaymentContextSelection;
    if (!selection.expiresAt || new Date(selection.expiresAt).getTime() < Date.now()
      || !selection.country || !selection.legalEntityCode || !selection.currency || !selection.regulatoryProfileCode
      || !selection.rail || !selection.corridor || !selection.provider || !selection.paymentMethod
      || !Number.isSafeInteger(selection.fees?.percentageBps) || !Number.isSafeInteger(selection.fees?.fixedAmount)) {
      throw new PaymentContextSelectionError('PAYMENT_CONTEXT_SELECTION_INVALID');
    }
    return selection;
  } catch (error) {
    if (error instanceof PaymentContextSelectionError) throw error;
    throw new PaymentContextSelectionError('PAYMENT_CONTEXT_SELECTION_INVALID');
  }
}

function paymentMethodForRail(rail: string): PaymentMethod | null {
  if (rail === 'stripe') return 'card';
  if (rail === 'mobile_money') return 'mobile_money';
  return null;
}

function paymentMethodPriority(method: PaymentMethod): number {
  if (method === 'card') return 0;
  return 1;
}

function normalizeCountry(country: string): string {
  const normalized = country.trim().toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(normalized)) throw new PaymentContextResolutionError('PAYMENT_CONTEXT_COUNTRY_INVALID');
  return normalized;
}

function countryCode(country: string): string {
  const normalized = country.trim().toUpperCase();
  if (normalized === 'FRANCE') return 'FR';
  if (normalized === 'CAMEROON' || normalized === 'CAMEROUN') return 'CM';
  if (normalized === 'CONGO' || normalized === 'CONGO-BRAZZAVILLE' || normalized === 'REPUBLIC OF THE CONGO') return 'CG';
  if (normalized === 'GABON') return 'GA';
  return normalized;
}

function isCurrent(profile: any): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return typeof profile.valid_from === 'string' && profile.valid_from <= today
    && (!profile.valid_until || profile.valid_until >= today);
}

function fees(profile: any): { percentageBps: number; fixedAmount: number } {
  const percentageBps = Number(profile.fee_percentage_bps);
  const fixedAmount = Number(profile.fee_fixed_amount);
  if (!Number.isSafeInteger(percentageBps) || percentageBps < 0
    || !Number.isSafeInteger(fixedAmount) || fixedAmount < 0) {
    throw new PaymentContextResolutionError('PAYMENT_CONTEXT_FEES_INVALID');
  }
  return { percentageBps, fixedAmount };
}

async function defaultFrappeClient(): Promise<FrappeClient> {
  return (await import('../../../infrastructure/adapters/erpnext-adapter.ts')).erpnext;
}

export class PaymentContextResolver {
  constructor(private readonly client: FrappeClient | (() => Promise<FrappeClient>) = defaultFrappeClient) {}

  private async frappe(): Promise<FrappeClient> {
    return typeof this.client === 'function' ? this.client() : this.client;
  }

  async resolve(countryInput: string, runtimeOperation = 'link_payment'): Promise<PaymentContext> {
    const country = normalizeCountry(countryInput);
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(runtimeOperation)) {
      throw new PaymentContextResolutionError('PAYMENT_CONTEXT_OPERATION_INVALID');
    }
    let frappe: FrappeClient;
    try {
      frappe = await this.frappe();
      const entities = (await frappe.list(
        'Konektag Legal Entity',
        { status: 'Approved' },
        ['name', 'entity_code', 'entity_name', 'country', 'currency', 'status'],
        100,
      )).filter(entity => countryCode(entity.country ?? '') === country);
      if (entities.length === 0) throw new PaymentContextResolutionError('PAYMENT_CONTEXT_LEGAL_ENTITY_NOT_FOUND');
      const profiles = (await frappe.list(
        'Konektag Regulatory Profile',
        { status: 'Approved', runtime_operation: runtimeOperation },
        ['name', 'profile_code', 'legal_entity', 'corridor', 'runtime_operation', 'rail', 'runtime_provider', 'provider_configuration_key', 'runtime_actor_code', 'status', 'valid_from', 'valid_until', 'fee_percentage_bps', 'fee_fixed_amount'],
        100,
      )).filter(isCurrent);
      const entityNames = new Set(entities.map(entity => entity.name));
      const eligibleProfiles = profiles.filter(profile => entityNames.has(profile.legal_entity));
      const eligibleEntityNames = new Set(eligibleProfiles.map(profile => profile.legal_entity));
      const eligibleEntities = entities.filter(entity => eligibleEntityNames.has(entity.name));
      if (eligibleEntities.length === 0) {
        if (entities.length > 1) throw new PaymentContextResolutionError('PAYMENT_CONTEXT_LEGAL_ENTITY_AMBIGUOUS');
        throw new PaymentContextResolutionError('PAYMENT_CONTEXT_REGULATORY_PROFILE_NOT_FOUND');
      }
      if (eligibleEntities.length > 1) throw new PaymentContextResolutionError('PAYMENT_CONTEXT_LEGAL_ENTITY_AMBIGUOUS');
      const legalEntity = eligibleEntities[0];
      if (!legalEntity.name || !legalEntity.entity_code || !legalEntity.entity_name || !legalEntity.currency) {
        throw new PaymentContextResolutionError('PAYMENT_CONTEXT_LEGAL_ENTITY_INVALID');
      }
      const legalEntityProfiles = eligibleProfiles.filter(profile => profile.legal_entity === legalEntity.name && profile.rail !== 'internal');

      const providers = await Promise.all(legalEntityProfiles.map(async profile => {
        const paymentMethod = paymentMethodForRail(profile.rail);
        if (!paymentMethod) throw new PaymentContextResolutionError('PAYMENT_CONTEXT_RAIL_UNSUPPORTED');
        if (!profile.name || !profile.profile_code || !profile.corridor || typeof profile.runtime_provider !== 'string') {
          throw new PaymentContextResolutionError('PAYMENT_CONTEXT_REGULATORY_PROFILE_INVALID');
        }
        const corridor = await frappe.get('Konektag Corridor', profile.corridor);
        if (corridor.status !== 'Approved' || !corridor.corridor_code
          || corridor.origin_entity !== legalEntity.name || corridor.destination_entity !== legalEntity.name) {
          throw new PaymentContextResolutionError('PAYMENT_CONTEXT_CORRIDOR_INVALID');
        }
        const feeValues = fees(profile);
        if (!profile.runtime_actor_code) throw new PaymentContextResolutionError('PAYMENT_CONTEXT_REGULATED_ACTOR_MISSING');
        if (typeof profile.provider_configuration_key !== 'string') {
          throw new PaymentContextResolutionError('PAYMENT_CONTEXT_PROVIDER_CONFIGURATION_INVALID');
        }
        try { assertProviderConfigurationKey(profile.runtime_provider, profile.provider_configuration_key); }
        catch (error) {
          if (error instanceof ProviderConfigurationError) throw new PaymentContextResolutionError('PAYMENT_CONTEXT_PROVIDER_CONFIGURATION_INVALID');
          throw error;
        }
        const actor = await frappe.get('Konektag Regulated Actor', profile.runtime_actor_code);
        if (actor.status !== 'Approved') throw new PaymentContextResolutionError('PAYMENT_CONTEXT_REGULATED_ACTOR_NOT_APPROVED');
        if (!actor.name || !actor.actor_code || !actor.actor_name) throw new PaymentContextResolutionError('PAYMENT_CONTEXT_REGULATED_ACTOR_INVALID');
        return {
          regulatoryProfile: { id: profile.name, code: profile.profile_code, rail: profile.rail },
          corridor: corridor.corridor_code,
          regulatedActor: { id: actor.name, code: actor.actor_code, name: actor.actor_name, logoUrl: typeof actor.logo_url === 'string' && actor.logo_url.trim() ? actor.logo_url : null },
          provider: profile.runtime_provider, providerConfigurationKey: profile.provider_configuration_key, paymentMethod, fees: feeValues,
        };
      }));

      if (providers.length === 0) throw new PaymentContextResolutionError('PAYMENT_CONTEXT_PROVIDER_NOT_FOUND');
      providers.sort((left, right) => {
        const byMethodPriority = paymentMethodPriority(left.paymentMethod) - paymentMethodPriority(right.paymentMethod);
        if (byMethodPriority !== 0) return byMethodPriority;
        const byCorridor = String(left.corridor).localeCompare(String(right.corridor));
        if (byCorridor !== 0) return byCorridor;
        return String(left.regulatoryProfile.code).localeCompare(String(right.regulatoryProfile.code));
      });
      return {
        country,
        legalEntity: { id: legalEntity.name, code: legalEntity.entity_code, legalName: legalEntity.entity_name },
        currency: legalEntity.currency,
        providers,
      };
    } catch (error) {
      if (error instanceof PaymentContextResolutionError) throw error;
      throw new PaymentContextResolutionError('PAYMENT_CONTEXT_FRAPPE_UNAVAILABLE');
    }
  }
}

export const paymentContextResolver = new PaymentContextResolver();
