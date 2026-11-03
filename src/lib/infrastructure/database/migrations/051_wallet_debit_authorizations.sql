-- Wallet debit OTP authorizations are independent of payment-source aggregates.
-- They store only a verifier; the one-time code is never persisted.
CREATE TABLE IF NOT EXISTS konektag.wallet_debit_authorizations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_user_id         UUID REFERENCES konektag.users(id),
  payer_party_id        UUID REFERENCES konektag.parties(id),
  operation_type        VARCHAR(40) NOT NULL CHECK (operation_type IN (
                          'recharge', 'qr_pay', 'transfer', 'api_payment', 'payment_link'
                        )),
  operation_id          VARCHAR(255) NOT NULL CHECK (length(trim(operation_id)) > 0),
  amount                BIGINT NOT NULL CHECK (amount > 0),
  currency              VARCHAR(3) NOT NULL CHECK (currency = upper(currency)),
  payee_snapshot        JSONB NOT NULL,
  otp_hash              CHAR(64) NOT NULL,
  otp_salt              CHAR(64) NOT NULL,
  lifecycle             VARCHAR(12) NOT NULL DEFAULT 'issued' CHECK (lifecycle IN (
                          'issued', 'approved', 'consumed', 'expired', 'revoked'
                        )),
  expires_at            TIMESTAMPTZ NOT NULL,
  attempts              SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  resend_count          SMALLINT NOT NULL DEFAULT 0 CHECK (resend_count >= 0 AND resend_count <= 3),
  last_sent_at          TIMESTAMPTZ,
  email_delivery_status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (email_delivery_status IN (
                          'pending', 'sent', 'failed'
                        )),
  approved_at           TIMESTAMPTZ,
  consumed_at           TIMESTAMPTZ,
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID REFERENCES konektag.users(id),
  updated_by            UUID REFERENCES konektag.users(id),
  CHECK (payer_user_id IS NOT NULL OR payer_party_id IS NOT NULL),
  CHECK ((lifecycle <> 'approved' AND approved_at IS NULL) OR approved_at IS NOT NULL),
  CHECK ((lifecycle <> 'consumed' AND consumed_at IS NULL) OR consumed_at IS NOT NULL)
);

-- An approved authorization remains active until it is consumed or revoked.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_debit_authorizations_active_operation_payer
  ON konektag.wallet_debit_authorizations(operation_type, operation_id, COALESCE(payer_user_id, payer_party_id))
  WHERE lifecycle IN ('issued', 'approved');

CREATE INDEX IF NOT EXISTS idx_wallet_debit_authorizations_payer_lifecycle_expiry
  ON konektag.wallet_debit_authorizations(payer_user_id, lifecycle, expires_at);

-- Supports the version-checked issued -> approved -> consumed updates.
CREATE INDEX IF NOT EXISTS idx_wallet_debit_authorizations_consume
  ON konektag.wallet_debit_authorizations(id, payer_user_id, lifecycle, version);
