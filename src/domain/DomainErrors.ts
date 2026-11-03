export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super('INVALID_TRANSITION', `Cannot transition from ${from} to ${to}`);
  }
}

export class ConcurrencyError extends DomainError {
  constructor(entity: string, id: string, version: number) {
    super('CONCURRENCY_CONFLICT', `${entity} ${id} version ${version} is stale`);
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super('NOT_FOUND', `${entity} with id ${id} not found`);
  }
}

export class OnboardingError extends DomainError {
  constructor(code: string) {
    super(code, `Onboarding error: ${code}`);
  }
}

export class RateLimitError extends DomainError {
  constructor(limit: number, windowSec: number) {
    super('RATE_LIMITED', `Rate limit exceeded: ${limit} requests per ${windowSec}s`);
  }
}

export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}
