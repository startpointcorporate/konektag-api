import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockClient = { query: vi.fn(), release: vi.fn() };
const mockPool = { query: vi.fn(), connect: vi.fn() };
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));

const mockErpProject = vi.fn();
const mockProjectRegistration = vi.fn();
vi.mock('../../src/application/services/erpnext-contact-service.ts', () => ({
  erpnextContactService: { project: mockErpProject, ensure: vi.fn(), projectConsent: vi.fn(), projectRegistration: mockProjectRegistration },
}));

const mockKeycloakUpdate = vi.fn();
vi.mock('../../src/infrastructure/adapters/keycloak-adapter.ts', () => ({
  KeycloakAdapter: class {
    updateUserAttributes = mockKeycloakUpdate;
    setUserEnabled = vi.fn();
  },
}));

const { mockAuditTag } = vi.hoisted(() => ({ mockAuditTag: vi.fn() }));
vi.mock('../../src/infrastructure/adapters/mautic-adapter.ts', () => ({
  mauticAdapter: { markAuditRequestedByEmail: mockAuditTag },
}));

const mockSendTemplate = vi.fn();
vi.mock('../../src/application/services/resend-service.ts', () => ({
  emailService: { sendTemplate: mockSendTemplate },
}));

const mockDecrypt = vi.fn();
vi.mock('../../src/infrastructure/adapters/encryption-service.ts', () => ({
  encryptionService: { decrypt: mockDecrypt },
}));

vi.mock('../../src/application/services/kyc-processor.ts', () => ({ processKycOrder: vi.fn() }));
vi.mock('../../src/application/services/mautic-contact-sync-service.ts', () => ({
  mauticContactSyncService: { syncUser: vi.fn(), syncMarketingConsent: vi.fn() },
}));
vi.mock('../../src/application/services/mautic-company-sync-service.ts', () => ({
  mauticCompanySyncService: { syncCompany: vi.fn(), removeContactFromCompany: vi.fn() },
}));
vi.mock('../../src/application/services/mautic-marketing-sync-service.ts', () => ({
  mauticMarketingSyncService: { syncProfile: vi.fn() },
}));
const mockProjectEvent = vi.fn();
vi.mock('../../src/application/projection/recharge-projection.ts', () => ({
  rechargeProjection: { projectEvent: mockProjectEvent },
}));
vi.mock('../../src/infrastructure/correlation-id.ts', () => ({
  getCorrelationId: () => 'corr-test-outbox',
}));

const originalFetch = globalThis.fetch;

const USER_ID = '11111111-2222-3333-4444-555555555555';
const USER2_ID = '66666666-7777-8888-9999-000000000000';
const KC_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const KC2_ID = 'ffffffff-1111-2222-3333-444444444444';
const ORDER_ID = '99999999-8888-7777-6666-555555555555';

let pendingEvents: any[];
let existingUsers: Record<string, { id: string; keycloak_id: string | null }>;
let failDeadLetterInsert: boolean;
let failBlockedUpdate: boolean;
let deadLetterAlreadyExists: boolean;

let processPending: () => Promise<void>;
let getOutboxMetrics: () => any;

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

function kycRejectedEvent(overrides: any = {}) {
  return {
    id: 'evt-1',
    event_type: 'KycRejected',
    aggregate_type: 'KycOrder',
    aggregate_id: ORDER_ID,
    aggregate_ref: null,
    correlation_id: 'corr-1',
    payload: { userId: USER_ID, reason: 'Document refused' },
    attempts: 0,
    created_at: '2026-07-28T10:00:00.000Z',
    blocked_at: null,
    ...overrides,
  };
}

function routeQueries() {
  mockPool.connect.mockImplementation(async () => mockClient);
  mockClient.query.mockImplementation(async (sql: string) => {
    if (String(sql).includes('FROM konektag.outbox_events')) return { rows: pendingEvents };
    return { rows: [] };
  });
  mockPool.query.mockImplementation(async (sql: string, params: any[] = []) => {
    const text = String(sql);
    if (text.includes('SELECT id, keycloak_id FROM konektag.users')) {
      const user = existingUsers[params[0]];
      return { rows: user ? [user] : [] };
    }
    if (text.includes('SELECT encrypted_data FROM konektag.users')) {
      return { rows: [{ encrypted_data: Buffer.from('enc') }] };
    }
    if (text.includes('INSERT INTO konektag.outbox_dead_letters')) {
      if (failDeadLetterInsert) throw new Error('dead letter persistence unavailable');
      return { rows: [], rowCount: deadLetterAlreadyExists ? 0 : 1 };
    }
    if (text.includes('blocked_reason = $3') && failBlockedUpdate) {
      throw new Error('retry state persistence unavailable');
    }
    return { rows: [{ age: null }] };
  });
}

const callsMatching = (fragment: string) =>
  mockPool.query.mock.calls.filter(([sql]: any) => {
    const statement = String(sql);
    // Retry assertions concern state writes, not the pending-event selector.
    return fragment === 'next_retry_at'
      ? /^\s*UPDATE\s+konektag\.outbox_events\b/i.test(statement) && statement.includes(fragment)
      : statement.includes(fragment);
  });

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  pendingEvents = [];
  existingUsers = {};
  failDeadLetterInsert = false;
  failBlockedUpdate = false;
  deadLetterAlreadyExists = false;
  mockErpProject.mockResolvedValue('CONTACT-1');
  mockKeycloakUpdate.mockResolvedValue(undefined);
  mockSendTemplate.mockResolvedValue(undefined);
  mockAuditTag.mockResolvedValue('tagged');
  mockProjectEvent.mockResolvedValue(undefined);
  mockDecrypt.mockReturnValue(JSON.stringify({ email: 'alice@example.com', firstName: 'Alice' }));
  process.env.ERPNEXT_URL = 'https://erp.example';
  process.env.KONEKTAG_INTEGRATION_SECRET = 'integration-secret';
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { accepted: true } }), { status: 200 }));
  routeQueries();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const mod = await import('../../src/application/outbox-dispatcher.ts');
  processPending = mod.processPending;
  getOutboxMetrics = mod.getOutboxMetrics;
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  globalThis.fetch = originalFetch;
});

describe('Outbox dispatcher — Frappe modular projections', () => {
  const projectionEvent = (overrides: any = {}) => ({
    id: '123e4567-e89b-12d3-a456-426614174000',
    event_type: 'MERCHANT_SETTLEMENT_APPROVED',
    aggregate_type: 'MerchantSettlement',
    aggregate_id: '11111111-2222-3333-4444-555555555555',
    correlation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    payload: { Amount: 100, Currency: 'XAF', ValueDate: '2026-08-04', SourceReference: 'SET-1', MerchantSettlementBatchId: '11111111-2222-3333-4444-555555555555', MerchantId: 'merchant-1', LegalEntity: 'entity-1', RegulatoryProfileId: 'profile-1', ActorId: 'checker-1' },
    attempts: 0,
    created_at: '2026-08-04T10:00:00.000Z',
    ...overrides,
  });

  it('posts the authenticated event envelope without an Administrator login', async () => {
    pendingEvents = [projectionEvent()];
    await processPending();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://erp.example/api/method/konektag_integration.konektag_integration.api.receive_event');
    expect(request.headers).toEqual({
      'Content-Type': 'application/json', 'Accept': 'application/json',
      'X-Konektag-Integration-Secret': 'integration-secret',
    });
    expect(request.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(request.body)).toEqual({
      event_id: '123e4567-e89b-12d3-a456-426614174000', event_type: 'MERCHANT_SETTLEMENT_APPROVED', event_version: 1,
      operation_id: 'SETTLEMENT-11111111-2222-3333-4444-555555555555', occurred_at: '2026-08-04T10:00:00.000Z',
      payload: projectionEvent().payload,
    });
    expect(callsMatching('SET processed_at = now(), attempts = attempts + 1')).toHaveLength(1);
  });

  it('fails closed and schedules a retry when integration configuration is missing', async () => {
    delete process.env.KONEKTAG_INTEGRATION_SECRET;
    pendingEvents = [projectionEvent()];
    await processPending();

    expect(globalThis.fetch).not.toHaveBeenCalled();
    const retry = callsMatching('next_retry_at = now()');
    expect(retry[0][1][1]).toBe('FRAPPE_INTEGRATION_SECRET_MISSING');
    expect(callsMatching('SET processed_at = now(), attempts = attempts + 1')).toHaveLength(0);
  });

  it('retries an HTTP failure with the same event identity for idempotent receipt', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { duplicate: true } }), { status: 200 }));
    pendingEvents = [projectionEvent()];
    await processPending();
    pendingEvents = [projectionEvent({ attempts: 1 })];
    await processPending();

    const bodies = (globalThis.fetch as any).mock.calls.map(([, request]: any[]) => JSON.parse(request.body));
    expect(bodies.map((body: any) => body.event_id)).toEqual(['123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174000']);
    expect(callsMatching('next_retry_at = now()')).toHaveLength(1);
    expect(callsMatching('SET processed_at = now(), attempts = attempts + 1')).toHaveLength(1);
  });

  it('dead-letters an authenticated Frappe rejection without scheduling a retry loop', async () => {
    (globalThis.fetch as any).mockResolvedValue(new Response('forbidden', { status: 403 }));
    pendingEvents = [projectionEvent()];
    await processPending();

    expect(callsMatching('INSERT INTO konektag.outbox_dead_letters')).toHaveLength(1);
    expect(callsMatching('next_retry_at')).toHaveLength(0);
    expect(callsMatching('dead_lettered_at = now()')).toHaveLength(1);
  });

  it('continues dispatching existing internal events without calling Frappe', async () => {
    existingUsers[USER_ID] = { id: USER_ID, keycloak_id: KC_ID };
    pendingEvents = [userEvent('OnboardingCompleted')];
    await processPending();

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockKeycloakUpdate).toHaveBeenCalledWith(KC_ID, { onboarding_state: 'COMPLETED' });
  });
});

describe('Outbox dispatcher — UserRegistered', () => {
  it('projects the Contact with the residence country recorded at registration', async () => {
    existingUsers[USER_ID] = { id: USER_ID, keycloak_id: KC_ID };
    pendingEvents = [userEvent('UserRegistered', { payload: { userId: USER_ID, keycloakId: KC_ID, legalCountry: 'BE' } })];
    await processPending();
    expect(mockProjectRegistration).toHaveBeenCalledWith(USER_ID, 'BE');
  });
});

describe('Outbox dispatcher — KycRejected delivery', () => {
  it('resolves the authoritative recipient once, delivers once, and marks the event processed', async () => {
    existingUsers[USER_ID] = { id: USER_ID, keycloak_id: KC_ID };
    pendingEvents = [kycRejectedEvent()];

    await processPending();

    // Authoritative identity resolved exactly once, by internal user id only.
    expect(callsMatching('SELECT id, keycloak_id FROM konektag.users')).toHaveLength(1);
    // Idempotent projections executed once each.
    expect(mockErpProject).not.toHaveBeenCalled();
    // Keycloak is addressed with the keycloak_id contract, not the internal id.
    expect(mockKeycloakUpdate).toHaveBeenCalledTimes(1);
    expect(mockKeycloakUpdate.mock.calls[0][0]).toBe(KC_ID);
    expect(mockKeycloakUpdate.mock.calls[0][0]).not.toBe(USER_ID);
    // Notification delivered exactly once.
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate.mock.calls[0][0]).toBe('kyc_rejected');
    // Event marked delivered; no retry schedule and no dead-letter state.
    expect(callsMatching('UPDATE konektag.outbox_events SET processed_at = now(), attempts = attempts + 1')).toHaveLength(1);
    expect(callsMatching('next_retry_at')).toHaveLength(0);
    expect(callsMatching('INSERT INTO konektag.outbox_dead_letters')).toHaveLength(0);
    expect(callsMatching('dead_lettered_at = now()')).toHaveLength(0);
  });

  it('dead-letters immediately with a sanitized reason when the referenced user is absent', async () => {
    pendingEvents = [kycRejectedEvent({ id: 'evt-absent' })];

    await processPending();

    // Authoritative lookup happened, no downstream delivery was invoked.
    expect(callsMatching('SELECT id, keycloak_id FROM konektag.users')).toHaveLength(1);
    expect(mockErpProject).not.toHaveBeenCalled();
    expect(mockKeycloakUpdate).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();

    // Terminal permanent failure on the first attempt: no retry scheduling.
    const dl = callsMatching('INSERT INTO konektag.outbox_dead_letters');
    expect(dl).toHaveLength(1);
    expect(dl[0][1][0]).toBe('evt-absent');               // original event identity retained
    expect(dl[0][1][3]).toBe(ORDER_ID);                    // aggregate identity retained (aggregate_ref was NULL)
    expect(dl[0][1][5]).toBe('OUTBOX_RECIPIENT_NOT_FOUND'); // sanitized reason code
    expect(dl[0][1][6]).toBe(1);                           // attempt evidence
    expect(callsMatching('next_retry_at')).toHaveLength(0);

    // Event leaves the normal pending queue without being marked delivered.
    const terminal = callsMatching('dead_lettered_at = now()');
    expect(terminal).toHaveLength(1);
    expect(terminal[0][1][2]).toBe('OUTBOX_RECIPIENT_NOT_FOUND');
    expect(callsMatching('attempts = attempts + 1 WHERE id')).toHaveLength(0);

    const metrics = getOutboxMetrics();
    expect(metrics.deadLetterCount).toBe(1);
    expect(metrics.deadLettersPerReason.OUTBOX_RECIPIENT_NOT_FOUND).toBe(1);
  });

  it('dead-letters a structurally invalid recipient identity without any lookup or fallback', async () => {
    pendingEvents = [
      kycRejectedEvent({ id: 'evt-malformed', payload: { userId: 'not-a-uuid', reason: 'x' } }),
      kycRejectedEvent({ id: 'evt-missing', payload: { reason: 'x' } }),
    ];

    await processPending();

    // No ambiguous lookup and no delivery was attempted for either event.
    expect(callsMatching('FROM konektag.users')).toHaveLength(0);
    expect(mockErpProject).not.toHaveBeenCalled();
    expect(mockKeycloakUpdate).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();

    const dl = callsMatching('INSERT INTO konektag.outbox_dead_letters');
    expect(dl).toHaveLength(2);
    expect(dl[0][1][5]).toBe('OUTBOX_RECIPIENT_INVALID');
    expect(dl[1][1][5]).toBe('OUTBOX_RECIPIENT_INVALID');
    expect(callsMatching('next_retry_at')).toHaveLength(0);
  });

  it('keeps the event retryable on a transient provider failure', async () => {
    existingUsers[USER_ID] = { id: USER_ID, keycloak_id: KC_ID };
    mockKeycloakUpdate.mockRejectedValueOnce(new Error('ECONNRESET: socket hang up'));
    pendingEvents = [kycRejectedEvent()];

    await processPending();

    const retry = callsMatching('next_retry_at = now()');
    expect(retry).toHaveLength(1);
    expect(retry[0][1][1]).toBe('ECONNRESET: socket hang up');
    expect(retry[0][1][2]).toBe(30); // first retry backoff, original schedule preserved
    // Attempts increased once, not dead-lettered, not delivered.
    expect(retry[0][0]).toContain('attempts = attempts + 1');
    expect(callsMatching('INSERT INTO konektag.outbox_dead_letters')).toHaveLength(0);
    expect(callsMatching('dead_lettered_at = now()')).toHaveLength(0);
    expect(callsMatching('SET processed_at = now(), attempts = attempts + 1')).toHaveLength(0);
    expect(getOutboxMetrics().retryCount).toBe(1);
  });

  it('reaches the terminal state exactly once when the maximum attempt budget is exhausted', async () => {
    existingUsers[USER_ID] = { id: USER_ID, keycloak_id: KC_ID };
    mockKeycloakUpdate.mockRejectedValue(new Error('Keycloak 500: boom'));
    pendingEvents = [kycRejectedEvent({ id: 'evt-exhausted', attempts: 4 })];

    await processPending();

    const dl = callsMatching('INSERT INTO konektag.outbox_dead_letters');
    expect(dl).toHaveLength(1);
    expect(String(dl[0][0])).toContain('WHERE NOT EXISTS'); // idempotent terminal insert
    expect(dl[0][1][5]).toBe('Keycloak 500: boom');
    expect(dl[0][1][6]).toBe(5);
    expect(callsMatching('dead_lettered_at = now()')).toHaveLength(1);
    // The notification was never sent: the non-idempotent step was not reached.
    expect(mockSendTemplate).not.toHaveBeenCalled();

    // A later worker pass does not reselect the terminal event and never
    // duplicates the dead-letter record.
    pendingEvents = [];
    await processPending();
    expect(callsMatching('INSERT INTO konektag.outbox_dead_letters')).toHaveLength(1);
    expect(callsMatching('dead_lettered_at = now()')).toHaveLength(1);
  });

  it('tolerates an already existing dead-letter record without duplicating it', async () => {
    deadLetterAlreadyExists = true; // guard blocks a second insert (rowCount 0)
    pendingEvents = [kycRejectedEvent({ id: 'evt-redl' })];

    await processPending();

    expect(callsMatching('INSERT INTO konektag.outbox_dead_letters')).toHaveLength(1);
    expect(callsMatching('dead_lettered_at = now()')).toHaveLength(1);
    expect(getOutboxMetrics().deadLetterCount).toBe(1);
  });

  it('applies the existing safe retry policy to unknown technical failures', async () => {
    existingUsers[USER_ID] = { id: USER_ID, keycloak_id: KC_ID };
    mockKeycloakUpdate.mockRejectedValueOnce(new Error('transient keycloak outage'));
    pendingEvents = [kycRejectedEvent()];

    await processPending();

    // Not falsely classified as recipient-not-found.
    expect(callsMatching('INSERT INTO konektag.outbox_dead_letters')).toHaveLength(0);
    const retry = callsMatching('next_retry_at = now()');
    expect(retry).toHaveLength(1);
    expect(retry[0][1][1]).toBe('transient keycloak outage');
    expect(retry[0][1][1]).not.toContain('OUTBOX_RECIPIENT');
  });

  it('does not redeliver an event that is no longer pending', async () => {
    existingUsers[USER_ID] = { id: USER_ID, keycloak_id: KC_ID };
    pendingEvents = [kycRejectedEvent()];

    await processPending();
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);

    // Second pass: the processed event is not selected again.
    pendingEvents = [];
    await processPending();

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockErpProject).not.toHaveBeenCalled();
    expect(mockKeycloakUpdate).toHaveBeenCalledTimes(1);
  });

  it('continues the batch when one event is permanently invalid', async () => {
    existingUsers[USER2_ID] = { id: USER2_ID, keycloak_id: KC2_ID };
    pendingEvents = [
      kycRejectedEvent({ id: 'evt-bad', payload: { userId: USER_ID, reason: 'gone' } }), // absent user
      kycRejectedEvent({ id: 'evt-good', payload: { userId: USER2_ID, reason: 'ok' } }),
    ];

    await processPending();

    // The invalid event reached terminal handling…
    const dl = callsMatching('INSERT INTO konektag.outbox_dead_letters');
    expect(dl).toHaveLength(1);
    expect(dl[0][1][0]).toBe('evt-bad');
    expect(dl[0][1][5]).toBe('OUTBOX_RECIPIENT_NOT_FOUND');

    // …and the independent valid event was still delivered in the same pass.
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockKeycloakUpdate).toHaveBeenCalledWith(KC2_ID, { kyc_status: 'rejected' });
    const delivered = callsMatching('UPDATE konektag.outbox_events SET processed_at = now(), attempts = attempts + 1');
    expect(delivered).toHaveLength(1);
    expect(delivered[0][1][0]).toBe('evt-good');
  });

  it('fails closed when the terminal state cannot be persisted', async () => {
    failDeadLetterInsert = true;
    pendingEvents = [kycRejectedEvent({ id: 'evt-fragile' })];

    await processPending();

    // The persistence failure propagated as a batch-level error…
    expect(errorSpy).toHaveBeenCalledWith('[Outbox] processPending error:', 'dead letter persistence unavailable');
    // …the event was not marked delivered…
    expect(callsMatching('UPDATE konektag.outbox_events SET processed_at = now(), attempts = attempts + 1')).toHaveLength(0);
    // …and no terminal update pretended the dead-letter was durably recorded.
    expect(callsMatching('dead_lettered_at = now()')).toHaveLength(0);
    expect(callsMatching('UPDATE konektag.outbox_events')).toHaveLength(0);
  });

  it('persists only sanitized failure evidence', async () => {
    pendingEvents = [kycRejectedEvent({ id: 'evt-pii' })];

    await processPending();

    const dl = callsMatching('INSERT INTO konektag.outbox_dead_letters');
    const failureReason = dl[0][1][5];
    const storedError = callsMatching('dead_lettered_at = now()')[0][1][2];
    const loggedText = [...errorSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map(String)
      .join('\n');

    for (const evidence of [failureReason, storedError, loggedText]) {
      expect(evidence).not.toContain('alice@example.com');
      expect(evidence).not.toContain('Alice');
      expect(evidence).not.toContain('Bearer');
      expect(evidence).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // no email addresses
      expect(evidence).not.toContain(JSON.stringify(kycRejectedEvent().payload));
    }
    expect(failureReason).toBe('OUTBOX_RECIPIENT_NOT_FOUND');
    expect(storedError).toBe('OUTBOX_RECIPIENT_NOT_FOUND');

    // The structured dead-letter log carries the reason code, event identity and correlation.
    const deadLetterLog = errorSpy.mock.calls
      .map((c: unknown[]) => String(c[1]))
      .find((line: string) => line.includes('OUTBOX_RECIPIENT_NOT_FOUND'));
    expect(deadLetterLog).toBeTruthy();
    const entry = JSON.parse(deadLetterLog!);
    expect(entry.level).toBe('error');
    expect(entry.error).toBe('OUTBOX_RECIPIENT_NOT_FOUND');
    expect(entry.eventId).toBe('evt-pii');
    expect(entry.correlationId).toBe('corr-1');
  });

  it('classifies permanent failures through a sanitized reason code error type', async () => {
    const { PermanentOutboxError, OUTBOX_RECIPIENT_NOT_FOUND } =
      await import('../../src/application/outbox-errors.ts');

    const err = new PermanentOutboxError(OUTBOX_RECIPIENT_NOT_FOUND);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('OUTBOX_RECIPIENT_NOT_FOUND');
    expect(err.reasonCode).toBe('OUTBOX_RECIPIENT_NOT_FOUND');
    expect(err.message).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});

function userEvent(eventType: string, overrides: any = {}) {
  return {
    id: 'evt-kc-1',
    event_type: eventType,
    aggregate_type: 'User',
    aggregate_id: USER_ID,
    aggregate_ref: null,
    correlation_id: 'corr-kc',
    payload: { userId: USER_ID },
    attempts: 0,
    created_at: '2026-07-28T10:00:00.000Z',
    blocked_at: null,
    ...overrides,
  };
}

describe.each(['KycVerified', 'OnboardingCompleted'])(
  'Outbox dispatcher — Keycloak identity for %s',
  (eventType) => {
    const expectedAttributes = eventType === 'KycVerified'
      ? { kyc_status: 'verified' }
      : { onboarding_state: 'COMPLETED' };

    it('addresses Keycloak with users.keycloak_id, never the internal UUID', async () => {
      existingUsers[USER_ID] = { id: USER_ID, keycloak_id: KC_ID };
      pendingEvents = [userEvent(eventType)];

      await processPending();

      // Exactly one authoritative user lookup by internal id.
      expect(callsMatching('SELECT id, keycloak_id FROM konektag.users')).toHaveLength(1);
      expect(mockKeycloakUpdate).toHaveBeenCalledTimes(1);
      expect(mockKeycloakUpdate.mock.calls[0][0]).toBe(KC_ID);
      expect(mockKeycloakUpdate.mock.calls[0][0]).not.toBe(USER_ID);
      expect(mockKeycloakUpdate.mock.calls[0][1]).toEqual(expectedAttributes);
      // Expected downstream behavior occurs once, event marked delivered.
      if (eventType === 'KycVerified') {
        expect(mockSendTemplate).toHaveBeenCalledTimes(1);
        expect(mockSendTemplate.mock.calls[0][0]).toBe('kyc_verified');
      }
      expect(callsMatching('UPDATE konektag.outbox_events SET processed_at = now(), attempts = attempts + 1')).toHaveLength(1);
      expect(callsMatching('INSERT INTO konektag.outbox_dead_letters')).toHaveLength(0);
      expect(callsMatching('next_retry_at')).toHaveLength(0);
    });

    it('dead-letters immediately when the internal user is missing', async () => {
      pendingEvents = [userEvent(eventType)];

      await processPending();

      expect(mockKeycloakUpdate).not.toHaveBeenCalled();
      expect(mockSendTemplate).not.toHaveBeenCalled();
      const dl = callsMatching('INSERT INTO konektag.outbox_dead_letters');
      expect(dl).toHaveLength(1);
      expect(dl[0][1][5]).toBe('OUTBOX_RECIPIENT_NOT_FOUND');
      expect(callsMatching('next_retry_at')).toHaveLength(0);
      expect(callsMatching('dead_lettered_at = now()')).toHaveLength(1);
    });

    it('dead-letters a malformed internal id without any user query', async () => {
      pendingEvents = [userEvent(eventType, { payload: { userId: 'not-a-uuid' } })];

      await processPending();

      expect(callsMatching('FROM konektag.users')).toHaveLength(0);
      expect(mockKeycloakUpdate).not.toHaveBeenCalled();
      const dl = callsMatching('INSERT INTO konektag.outbox_dead_letters');
      expect(dl).toHaveLength(1);
      expect(dl[0][1][5]).toBe('OUTBOX_RECIPIENT_INVALID');
    });

    it('dead-letters when the resolved user has no usable keycloak_id', async () => {
      existingUsers[USER_ID] = { id: USER_ID, keycloak_id: null };
      pendingEvents = [userEvent(eventType)];

      await processPending();

      // Internal user resolved, but Keycloak is never called and the
      // internal UUID is never substituted.
      expect(callsMatching('SELECT id, keycloak_id FROM konektag.users')).toHaveLength(1);
      expect(mockKeycloakUpdate).not.toHaveBeenCalled();
      expect(mockSendTemplate).not.toHaveBeenCalled();
      const dl = callsMatching('INSERT INTO konektag.outbox_dead_letters');
      expect(dl).toHaveLength(1);
      expect(dl[0][1][5]).toBe('OUTBOX_KEYCLOAK_ID_MISSING');
      expect(dl[0][1][5]).not.toContain(USER_ID);
      expect(callsMatching('next_retry_at')).toHaveLength(0);
    });

    it('keeps the event retryable on a transient Keycloak failure', async () => {
      existingUsers[USER_ID] = { id: USER_ID, keycloak_id: KC_ID };
      mockKeycloakUpdate.mockRejectedValueOnce(new Error('keycloak 503 unavailable'));
      pendingEvents = [userEvent(eventType)];

      await processPending();

      // The valid keycloak_id was used…
      expect(mockKeycloakUpdate.mock.calls[0][0]).toBe(KC_ID);
      // …the failure is not misclassified as recipient-not-found…
      expect(callsMatching('INSERT INTO konektag.outbox_dead_letters')).toHaveLength(0);
      // …and normal retry policy applies.
      const retry = callsMatching('next_retry_at = now()');
      expect(retry).toHaveLength(1);
      expect(retry[0][1][1]).toBe('keycloak 503 unavailable');
      // The non-idempotent notification was not sent before the failed step.
      expect(mockSendTemplate).not.toHaveBeenCalled();
    });
  },
);

function rechargeEvent(overrides: any = {}) {
  return {
    id: 'evt-blocked-1',
    event_type: 'RechargeCreated',
    aggregate_type: 'Recharge',
    aggregate_id: null,
    aggregate_ref: 'KTG-RECH-1',
    correlation_id: 'corr-blocked',
    payload: { rechargeName: 'KTG-RECH-1' },
    attempts: 0,
    created_at: '2026-07-28T10:00:00.000Z',
    blocked_at: null,
    ...overrides,
  };
}

describe('Outbox dispatcher — blocked_retry bounds', () => {
  it('increments once and schedules a deterministic retry below the limit', async () => {
    mockProjectEvent.mockRejectedValueOnce(new Error('blocked_missing_predecessor'));
    pendingEvents = [rechargeEvent()];

    await processPending();

    const blocked = callsMatching("blocked_reason = $3");
    expect(blocked).toHaveLength(1);
    expect(blocked[0][0]).toContain('attempts = attempts + 1'); // one attempt consumed
    expect(blocked[0][1][1]).toBe('blocked_missing_predecessor'); // sanitized classification
    expect(blocked[0][1][2]).toBe('blocked_retry');
    expect(blocked[0][1][3]).toBe(30); // deterministic backoff, no 0s tight loop
    // Event remains undelivered, no terminal record, no immediate reselection.
    expect(callsMatching('INSERT INTO konektag.outbox_dead_letters')).toHaveLength(0);
    expect(callsMatching('dead_lettered_at = now()')).toHaveLength(0);
    expect(callsMatching('SET processed_at = now(), attempts = attempts + 1')).toHaveLength(0);
    expect(getOutboxMetrics().blockedCount).toBe(1);
  });

  it('terminates through the DLQ exactly once when the shared attempt budget is exhausted', async () => {
    mockProjectEvent.mockRejectedValue(new Error('blocked_missing_predecessor'));
    pendingEvents = [rechargeEvent({ attempts: 4 })];

    await processPending();

    // No further retry is scheduled…
    expect(callsMatching('blocked_reason = $3')).toHaveLength(0);
    // …the event becomes terminal through the established mechanism…
    const dl = callsMatching('INSERT INTO konektag.outbox_dead_letters');
    expect(dl).toHaveLength(1);
    expect(String(dl[0][0])).toContain('WHERE NOT EXISTS');
    expect(dl[0][1][0]).toBe('evt-blocked-1');
    expect(dl[0][1][5]).toBe('blocked_missing_predecessor');
    expect(dl[0][1][6]).toBe(5);
    expect(callsMatching('dead_lettered_at = now()')).toHaveLength(1);
    // …and it is not marked delivered.
    expect(callsMatching('SET processed_at = now(), attempts = attempts + 1')).toHaveLength(0);

    // A later worker pass does not reselect the terminal event nor duplicate evidence.
    pendingEvents = [];
    await processPending();
    expect(callsMatching('INSERT INTO konektag.outbox_dead_letters')).toHaveLength(1);
    expect(mockProjectEvent).toHaveBeenCalledTimes(1);
  });

  it('tolerates an already existing dead-letter record without duplicating it', async () => {
    deadLetterAlreadyExists = true;
    mockProjectEvent.mockRejectedValue(new Error('blocked_missing_predecessor'));
    pendingEvents = [rechargeEvent({ attempts: 4 })];

    await processPending();

    expect(callsMatching('INSERT INTO konektag.outbox_dead_letters')).toHaveLength(1);
    expect(callsMatching('dead_lettered_at = now()')).toHaveLength(1);
    expect(getOutboxMetrics().deadLetterCount).toBe(1);
  });

  it('continues the batch when one blocked event reaches its limit', async () => {
    existingUsers[USER_ID] = { id: USER_ID, keycloak_id: KC_ID };
    mockProjectEvent.mockRejectedValue(new Error('blocked_missing_predecessor'));
    pendingEvents = [
      rechargeEvent({ id: 'evt-blocked-max', attempts: 4 }),
      userEvent('KycVerified', { id: 'evt-valid' }),
    ];

    await processPending();

    // The exhausted blocked event is terminal…
    const dl = callsMatching('INSERT INTO konektag.outbox_dead_letters');
    expect(dl).toHaveLength(1);
    expect(dl[0][1][0]).toBe('evt-blocked-max');
    // …and the independent valid event was still delivered in the same pass.
    expect(mockKeycloakUpdate).toHaveBeenCalledWith(KC_ID, { kyc_status: 'verified' });
    const delivered = callsMatching('UPDATE konektag.outbox_events SET processed_at = now(), attempts = attempts + 1');
    expect(delivered).toHaveLength(1);
    expect(delivered[0][1][0]).toBe('evt-valid');
  });

  it('fails closed when the retry state cannot be persisted', async () => {
    failBlockedUpdate = true;
    mockProjectEvent.mockRejectedValueOnce(new Error('blocked_missing_predecessor'));
    pendingEvents = [rechargeEvent()];

    await processPending();

    // The persistence failure propagated as a batch-level error…
    expect(errorSpy).toHaveBeenCalledWith('[Outbox] processPending error:', 'retry state persistence unavailable');
    // …the event was not marked delivered…
    expect(callsMatching('SET processed_at = now(), attempts = attempts + 1')).toHaveLength(0);
    // …and no retry was falsely reported as durably scheduled.
    expect(callsMatching('dead_lettered_at = now()')).toHaveLength(0);
  });

  it('fails closed when the terminal state cannot be persisted', async () => {
    failDeadLetterInsert = true;
    mockProjectEvent.mockRejectedValue(new Error('blocked_missing_predecessor'));
    pendingEvents = [rechargeEvent({ attempts: 4 })];

    await processPending();

    expect(errorSpy).toHaveBeenCalledWith('[Outbox] processPending error:', 'dead letter persistence unavailable');
    expect(callsMatching('SET processed_at = now(), attempts = attempts + 1')).toHaveLength(0);
    expect(callsMatching('UPDATE konektag.outbox_events')).toHaveLength(0);
  });

  it('persists only sanitized blocked failure evidence', async () => {
    mockProjectEvent.mockRejectedValue(new Error('blocked_missing_predecessor'));
    pendingEvents = [rechargeEvent({ id: 'evt-pii-blocked', attempts: 4 })];

    await processPending();

    const failureReason = callsMatching('INSERT INTO konektag.outbox_dead_letters')[0][1][5];
    const storedError = callsMatching('dead_lettered_at = now()')[0][1][2];
    const loggedText = [...errorSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map(String)
      .join('\n');

    for (const evidence of [failureReason, storedError, loggedText]) {
      expect(evidence).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // no email addresses
      expect(evidence).not.toContain('Alice');
      expect(evidence).not.toContain('Bearer');
      expect(evidence).not.toContain('postgres://');
      expect(evidence).not.toContain(JSON.stringify(rechargeEvent().payload));
    }
    expect(failureReason).toBe('blocked_missing_predecessor');
  });
});


describe('A03 Digital Audit — existing outbox retry', () => {
  const auditEvent = (overrides: Record<string, unknown> = {}) => ({
    id: '123e4567-e89b-12d3-a456-426614174077',
    event_type: 'DigitalAuditRequested',
    aggregate_type: 'DigitalAudit',
    aggregate_id: '123e4567-e89b-12d3-a456-426614174078',
    payload: { email: 'existing@example.com' },
    attempts: 0,
    ...overrides,
  });

  it('applies the tag for an existing Contact and marks the event processed', async () => {
    pendingEvents = [auditEvent()];
    await processPending();
    expect(mockAuditTag).toHaveBeenCalledTimes(1);
    expect(mockAuditTag).toHaveBeenCalledWith('existing@example.com');
    expect(callsMatching('SET processed_at = now(), attempts = attempts + 1')).toHaveLength(1);
  });

  it('treats an absent Mautic Contact as a successful request (never creates one)', async () => {
    mockAuditTag.mockResolvedValue('not_found');
    pendingEvents = [auditEvent()];
    await processPending();
    expect(mockAuditTag).toHaveBeenCalledTimes(1);
    expect(callsMatching('SET processed_at = now(), attempts = attempts + 1')).toHaveLength(1);
    expect(callsMatching('next_retry_at')).toHaveLength(0);
  });

  it('retries Mautic unavailability rather than losing the audit request', async () => {
    mockAuditTag.mockRejectedValue(new Error('MAUTIC_AUDIT_DELIVERY_FAILED'));
    pendingEvents = [auditEvent()];
    await processPending();
    expect(mockAuditTag).toHaveBeenCalledTimes(1);
    expect(callsMatching('next_retry_at')).toHaveLength(1);
    expect(callsMatching('SET processed_at = now(), attempts = attempts + 1')).toHaveLength(0);
  });

  it('dead-letters malformed audit events without any Mautic call', async () => {
    pendingEvents = [auditEvent({ payload: { email: null } })];
    await processPending();
    expect(mockAuditTag).not.toHaveBeenCalled();
    expect(callsMatching('INSERT INTO konektag.outbox_dead_letters')).toHaveLength(1);
  });
});
