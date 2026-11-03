BEGIN;

ALTER TABLE konektag.merchant_pro_renewal_intents
  ALTER COLUMN subscription_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS initial_approved_by UUID REFERENCES konektag.users(id),
  ADD COLUMN IF NOT EXISTS initial_approved_at TIMESTAMPTZ;

ALTER TABLE konektag.merchant_pro_renewal_intents
  ADD CONSTRAINT merchant_pro_intent_kind_check
  CHECK ((subscription_id IS NOT NULL AND initial_approved_by IS NULL)
      OR (subscription_id IS NULL AND initial_approved_by IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS merchant_pro_one_pending_initial_payment
  ON konektag.merchant_pro_renewal_intents(merchant_profile_id)
  WHERE status='PENDING' AND subscription_id IS NULL;

COMMIT;
