-- Immutable evidence for manually verified Mobile Money collections.
CREATE TABLE IF NOT EXISTS konektag.mobile_money_receipts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type         VARCHAR(30) NOT NULL CHECK (source_type IN ('recharge', 'api_payment')),
  source_id           VARCHAR(255) NOT NULL CHECK (length(trim(source_id)) > 0),
  provider            VARCHAR(50) NOT NULL CHECK (length(trim(provider)) > 0),
  country             VARCHAR(2) NOT NULL CHECK (country = upper(country) AND country ~ '^[A-Z]{2}$'),
  operator            VARCHAR(50) NOT NULL CHECK (length(trim(operator)) > 0),
  provider_reference  VARCHAR(255) NOT NULL CHECK (length(trim(provider_reference)) > 0),
  amount              BIGINT NOT NULL CHECK (amount > 0),
  currency            VARCHAR(3) NOT NULL CHECK (currency = upper(currency) AND currency ~ '^[A-Z]{3}$'),
  received_at         TIMESTAMPTZ NOT NULL,
  masked_sender       VARCHAR(80) NOT NULL CHECK (masked_sender ~ '[*]'),
  evidence_reference  VARCHAR(255),
  evidence_hash       CHAR(64),
  note                TEXT,
  verification_method VARCHAR(50) NOT NULL,
  verified_by         UUID NOT NULL REFERENCES konektag.users(id),
  verified_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id),
  UNIQUE (provider, country, provider_reference),
  CHECK (evidence_reference IS NULL OR evidence_hash IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_mobile_money_receipts_verified_at
  ON konektag.mobile_money_receipts(verified_at DESC);

-- Receipts are financial evidence, not mutable workflow state.
CREATE OR REPLACE FUNCTION konektag.reject_mobile_money_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'mobile_money_receipts are immutable';
END;
$$;

DROP TRIGGER IF EXISTS mobile_money_receipts_immutable ON konektag.mobile_money_receipts;
CREATE TRIGGER mobile_money_receipts_immutable
  BEFORE UPDATE OR DELETE ON konektag.mobile_money_receipts
  FOR EACH ROW EXECUTE FUNCTION konektag.reject_mobile_money_receipt_mutation();
