import { DomainError, NotFoundError } from './DomainErrors.ts';

export class MerchantProfileNotFoundError extends NotFoundError {
  constructor(identifier: string) {
    super('MerchantProfile', identifier);
  }
}

export class MerchantNotOwnerError extends DomainError {
  constructor() {
    super('MERCHANT_NOT_OWNER', 'You are not the owner of this merchant profile');
  }
}

export class MerchantSlugTakenError extends DomainError {
  constructor(slug: string) {
    super('MERCHANT_SLUG_TAKEN', `Slug "${slug}" is already in use`);
  }
}

export class MerchantCannotPublishError extends DomainError {
  constructor(reason: string) {
    super('MERCHANT_CANNOT_PUBLISH', `Cannot publish: ${reason}`);
  }
}

export type MerchantLocationField = 'country' | 'city';

/** A merchant establishment must always have a non-blank country and city. */
export class MerchantLocationRequiredError extends DomainError {
  constructor(readonly missing: MerchantLocationField[]) {
    super('MERCHANT_LOCATION_REQUIRED', `Le pays et la ville du commerce sont obligatoires (manquant : ${missing.join(', ')})`);
  }
}

export class MerchantMediaLimitError extends DomainError {
  constructor(max: number) {
    super('MERCHANT_MEDIA_LIMIT', `Maximum ${max} media items reached`);
  }
}

export class MerchantInvalidUrlError extends DomainError {
  constructor(url: string) {
    super('MERCHANT_INVALID_URL', `Invalid URL: ${url}`);
  }
}

export class MerchantCertificationIncompleteError extends DomainError {
  constructor(missingDocs: string[]) {
    super('CERTIFICATION_INCOMPLETE', `Dossier incomplet : documents manquants : ${missingDocs.join(', ')}`);
  }
}

export class MerchantCertificationTransactionsInsufficientError extends DomainError {
  constructor(current: number, required: number) {
    super('CERTIFICATION_TX_INSUFFICIENT', `Transactions insuffisantes : ${current}/${required} requises`);
  }
}

export class MerchantAlreadyCertifiedError extends DomainError {
  constructor() {
    super('ALREADY_CERTIFIED', 'Ce commerce est déjà certifié ou en cours de validation');
  }
}

export class MerchantActivationRequiredError extends DomainError {
  constructor(reason: string) {
    super('MERCHANT_NOT_ACTIVATED', reason);
  }
}
