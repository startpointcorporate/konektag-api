BEGIN;
CREATE TABLE IF NOT EXISTS konektag.payment_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES konektag.users(id),
  payment_order_id UUID REFERENCES konektag.api_payment_orders(id),
  provider VARCHAR(50),
  provider_reference VARCHAR(255),
  claimed_amount NUMERIC,
  currency VARCHAR(3),
  reason TEXT NOT NULL,
  evidence_ref VARCHAR(500),
  status VARCHAR(30) NOT NULL DEFAULT 'OPEN'
    CHECK(status IN ('OPEN','AUTO_RECONCILING','PENDING_REVIEW','APPROVED','CREDITED','REJECTED')),
  resolution TEXT,
  resolved_by UUID REFERENCES konektag.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CHECK(payment_order_id IS NOT NULL OR provider_reference IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_payment_claims_user ON konektag.payment_claims(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_claims_status ON konektag.payment_claims(status,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_payment_claim
 ON konektag.payment_claims(user_id,COALESCE(payment_order_id,'00000000-0000-0000-0000-000000000000'::uuid),COALESCE(provider_reference,''))
 WHERE status IN ('OPEN','AUTO_RECONCILING','PENDING_REVIEW','APPROVED');
COMMIT;
