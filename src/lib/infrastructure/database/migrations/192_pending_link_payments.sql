BEGIN;

CREATE TABLE konektag.pending_link_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_user_id UUID NOT NULL REFERENCES konektag.users(id) ON DELETE CASCADE,
  checkout_intent_id UUID NOT NULL REFERENCES konektag.checkout_intents(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payer_user_id, checkout_intent_id)
);

CREATE INDEX idx_pending_link_payments_user
  ON konektag.pending_link_payments(payer_user_id, created_at DESC);

COMMIT;
