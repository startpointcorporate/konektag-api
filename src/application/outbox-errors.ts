/**
 * Outbox delivery failure classification.
 *
 * A PermanentOutboxError marks an event as objectively undeliverable
 * (e.g. its authoritative recipient reference no longer exists or is
 * structurally invalid). The dispatcher moves such events straight to
 * the established dead-letter queue instead of retrying them until the
 * maximum attempt budget is exhausted.
 *
 * The error message is always a stable, sanitized reason code: it is
 * persisted in outbox_events.error_message and
 * outbox_dead_letters.failure_reason and appears in structured logs,
 * so it must never contain personal data, credentials, or payload
 * details.
 */

/** The authoritative recipient referenced by the event does not exist. */
export const OUTBOX_RECIPIENT_NOT_FOUND = 'OUTBOX_RECIPIENT_NOT_FOUND';

/** The recipient identifier carried by the event is missing or malformed. */
export const OUTBOX_RECIPIENT_INVALID = 'OUTBOX_RECIPIENT_INVALID';

/**
 * The resolved user has no usable Keycloak identifier, so no Keycloak
 * delivery can ever succeed for this event. The internal user UUID must
 * never be substituted for the missing keycloak_id.
 */
export const OUTBOX_KEYCLOAK_ID_MISSING = 'OUTBOX_KEYCLOAK_ID_MISSING';

export class PermanentOutboxError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = 'PermanentOutboxError';
    this.reasonCode = reasonCode;
  }
}
