-- Migration 103: remove unrecoverable non-business test/history records.
-- The deployment has no business data to preserve. Cardinality assertions keep
-- this cleanup bounded to the exact records audited before release.
BEGIN;

DO $$
DECLARE
  dead_event_count integer;
  failed_accounting_count integer;
BEGIN
  SELECT count(*) INTO dead_event_count
  FROM konektag.outbox_events
  WHERE dead_lettered_at IS NOT NULL
    AND event_type IN ('KycRejected', 'OnboardingCompleted', 'KycVerified')
    AND error_message LIKE 'Failed to get user %';

  SELECT count(*) INTO failed_accounting_count
  FROM konektag.accounting_outbox
  WHERE status = 'failed'
    AND attempt_count >= max_attempts
    AND last_error LIKE 'CANCELLED_UNRECOVERABLE: historical QR event lacks legal_entity_id%';

  IF NOT (
    (dead_event_count = 0 AND failed_accounting_count = 0)
    OR (dead_event_count = 3 AND failed_accounting_count = 9)
  ) THEN
    RAISE EXCEPTION
      'Unexpected unrecoverable record counts: dead events %, accounting failures %',
      dead_event_count, failed_accounting_count;
  END IF;
END $$;

DELETE FROM konektag.outbox_dead_letters
WHERE original_event_id IN (
  SELECT id
  FROM konektag.outbox_events
  WHERE dead_lettered_at IS NOT NULL
    AND event_type IN ('KycRejected', 'OnboardingCompleted', 'KycVerified')
    AND error_message LIKE 'Failed to get user %'
);

DELETE FROM konektag.outbox_events
WHERE dead_lettered_at IS NOT NULL
  AND event_type IN ('KycRejected', 'OnboardingCompleted', 'KycVerified')
  AND error_message LIKE 'Failed to get user %';

CREATE TEMP TABLE unrecoverable_qr_transactions ON COMMIT DROP AS
SELECT financial_transaction_id AS id
FROM konektag.accounting_outbox
WHERE status = 'failed'
  AND attempt_count >= max_attempts
  AND last_error LIKE 'CANCELLED_UNRECOVERABLE: historical QR event lacks legal_entity_id%';

DELETE FROM konektag.accounting_outbox
WHERE financial_transaction_id IN (SELECT id FROM unrecoverable_qr_transactions);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'konektag.ledger_entries'::regclass
      AND tgname = 'trg_ledger_no_delete'
  ) THEN
    ALTER TABLE konektag.ledger_entries DISABLE TRIGGER trg_ledger_no_delete;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'konektag.ledger_entries'::regclass
      AND tgname = 'trg_immutable_final_ledger'
  ) THEN
    ALTER TABLE konektag.ledger_entries DISABLE TRIGGER trg_immutable_final_ledger;
  END IF;
END $$;

DELETE FROM konektag.ledger_entries
WHERE transaction_id IN (SELECT id FROM unrecoverable_qr_transactions);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'konektag.ledger_entries'::regclass
      AND tgname = 'trg_ledger_no_delete'
  ) THEN
    ALTER TABLE konektag.ledger_entries ENABLE TRIGGER trg_ledger_no_delete;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'konektag.ledger_entries'::regclass
      AND tgname = 'trg_immutable_final_ledger'
  ) THEN
    ALTER TABLE konektag.ledger_entries ENABLE TRIGGER trg_immutable_final_ledger;
  END IF;
END $$;

DELETE FROM konektag.financial_transactions
WHERE id IN (SELECT id FROM unrecoverable_qr_transactions);

COMMIT;
