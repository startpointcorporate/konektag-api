BEGIN;

-- Migration 183 introduced a mutable country/VAT lookup. Preserve every row,
-- but make legacy rows non-runnable until their legal basis is approved.
ALTER TABLE konektag.wallet_recharge_tax_rules
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3),
  ADD COLUMN IF NOT EXISTS tax_code TEXT,
  ADD COLUMN IF NOT EXISTS calculation_kind TEXT,
  ADD COLUMN IF NOT EXISTS fixed_amount_minor BIGINT,
  ADD COLUMN IF NOT EXISTS taxable_basis TEXT,
  ADD COLUMN IF NOT EXISTS minor_digits SMALLINT,
  ADD COLUMN IF NOT EXISTS rounding_mode TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS source_reference TEXT,
  ADD COLUMN IF NOT EXISTS approval_reference TEXT,
  ADD COLUMN IF NOT EXISTS approved_by TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

UPDATE konektag.wallet_recharge_tax_rules
SET currency = COALESCE(currency, CASE country_code WHEN 'FR' THEN 'EUR' END),
    tax_code = COALESCE(tax_code, upper(regexp_replace(tax_name, '[^[:alnum:]]+', '_', 'g'))),
    calculation_kind = COALESCE(calculation_kind, 'PERCENTAGE'),
    taxable_basis = COALESCE(taxable_basis, 'RECHARGE_AMOUNT'),
    minor_digits = COALESCE(minor_digits, CASE country_code WHEN 'FR' THEN 2 END),
    rounding_mode = COALESCE(rounding_mode, 'HALF_UP'),
    status = COALESCE(status, 'DRAFT'),
    source_reference = COALESCE(source_reference, 'LEGACY-MIGRATION-183-UNVERIFIED')
WHERE currency IS NULL OR tax_code IS NULL OR calculation_kind IS NULL
   OR taxable_basis IS NULL OR minor_digits IS NULL OR rounding_mode IS NULL
   OR status IS NULL OR source_reference IS NULL;

ALTER TABLE konektag.wallet_recharge_tax_rules
  ALTER COLUMN tax_code SET NOT NULL,
  ALTER COLUMN calculation_kind SET NOT NULL,
  ALTER COLUMN taxable_basis SET NOT NULL,
  ALTER COLUMN rounding_mode SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN source_reference SET NOT NULL,
  ALTER COLUMN valid_from TYPE TIMESTAMPTZ USING valid_from::timestamptz,
  ALTER COLUMN valid_until TYPE TIMESTAMPTZ USING
    CASE WHEN valid_until IS NULL THEN NULL ELSE (valid_until + 1)::timestamptz END;

DROP INDEX IF EXISTS konektag.wallet_recharge_tax_rules_active_identity;

ALTER TABLE konektag.wallet_recharge_tax_rules
  ADD CONSTRAINT wallet_recharge_tax_country_ck CHECK (country_code ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT wallet_recharge_tax_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT wallet_recharge_tax_kind_ck CHECK (calculation_kind IN ('PERCENTAGE','FIXED')),
  ADD CONSTRAINT wallet_recharge_tax_basis_ck CHECK (taxable_basis IN ('RECHARGE_AMOUNT','FEE','RECHARGE_AMOUNT_AND_FEE')),
  ADD CONSTRAINT wallet_recharge_tax_digits_ck CHECK (minor_digits BETWEEN 0 AND 4),
  ADD CONSTRAINT wallet_recharge_tax_rounding_ck CHECK (rounding_mode = 'HALF_UP'),
  ADD CONSTRAINT wallet_recharge_tax_status_ck CHECK (status IN ('DRAFT','APPROVED','REVOKED')),
  ADD CONSTRAINT wallet_recharge_tax_value_ck CHECK (
    (calculation_kind = 'PERCENTAGE' AND rate_basis_points IS NOT NULL AND fixed_amount_minor IS NULL)
    OR (calculation_kind = 'FIXED' AND fixed_amount_minor >= 0 AND rate_basis_points = 0)
  ),
  ADD CONSTRAINT wallet_recharge_tax_approval_ck CHECK (
    status <> 'APPROVED' OR (
      currency IS NOT NULL AND minor_digits IS NOT NULL
      AND approval_reference IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL
    )
  );

CREATE INDEX wallet_recharge_tax_rule_lookup
  ON konektag.wallet_recharge_tax_rules(country_code, currency, status, valid_from, valid_until);

CREATE TABLE konektag.wallet_recharge_limit_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code VARCHAR(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rail TEXT NOT NULL CHECK (length(btrim(rail)) > 0),
  provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  kyc_level TEXT NOT NULL CHECK (length(btrim(kyc_level)) > 0),
  minor_digits SMALLINT NOT NULL CHECK (minor_digits BETWEEN 0 AND 4),
  minimum_minor BIGINT NOT NULL CHECK (minimum_minor >= 0),
  per_transaction_minor BIGINT NOT NULL CHECK (per_transaction_minor >= minimum_minor),
  daily_minor BIGINT NOT NULL CHECK (daily_minor >= per_transaction_minor),
  monthly_minor BIGINT NOT NULL CHECK (monthly_minor >= daily_minor),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','APPROVED','REVOKED')),
  source_reference TEXT NOT NULL CHECK (length(btrim(source_reference)) > 0),
  approval_reference TEXT,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (status <> 'APPROVED' OR (approval_reference IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE INDEX wallet_recharge_limit_rule_lookup
  ON konektag.wallet_recharge_limit_rules(country_code, currency, rail, provider, kyc_level, status, valid_from, valid_until);

CREATE OR REPLACE FUNCTION konektag.guard_wallet_recharge_rule_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'APPROVED' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'wallet_recharge_tax_rules' AND NOT NEW.enabled THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'wallet_recharge_tax_rules' AND EXISTS (
    SELECT 1 FROM konektag.wallet_recharge_tax_rules r
    WHERE r.id <> NEW.id AND r.status = 'APPROVED' AND r.enabled
      AND r.country_code = NEW.country_code AND r.currency = NEW.currency AND r.tax_code = NEW.tax_code
      AND tstzrange(r.valid_from, r.valid_until, '[)') && tstzrange(NEW.valid_from, NEW.valid_until, '[)')
  ) THEN RAISE EXCEPTION 'WALLET_RECHARGE_TAX_RULE_OVERLAP';
  ELSIF TG_TABLE_NAME = 'wallet_recharge_limit_rules' AND EXISTS (
    SELECT 1 FROM konektag.wallet_recharge_limit_rules r
    WHERE r.id <> NEW.id AND r.status = 'APPROVED'
      AND (r.country_code, r.currency, r.rail, r.provider, r.kyc_level) =
          (NEW.country_code, NEW.currency, NEW.rail, NEW.provider, NEW.kyc_level)
      AND tstzrange(r.valid_from, r.valid_until, '[)') && tstzrange(NEW.valid_from, NEW.valid_until, '[)')
  ) THEN RAISE EXCEPTION 'WALLET_RECHARGE_LIMIT_RULE_OVERLAP';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_recharge_tax_rule_no_overlap
BEFORE INSERT OR UPDATE ON konektag.wallet_recharge_tax_rules
FOR EACH ROW EXECUTE FUNCTION konektag.guard_wallet_recharge_rule_overlap();
CREATE TRIGGER wallet_recharge_limit_rule_no_overlap
BEFORE INSERT OR UPDATE ON konektag.wallet_recharge_limit_rules
FOR EACH ROW EXECUTE FUNCTION konektag.guard_wallet_recharge_rule_overlap();

CREATE OR REPLACE FUNCTION konektag.resolve_wallet_recharge_tax_rules(
  p_country_code TEXT, p_currency TEXT, p_at TIMESTAMPTZ DEFAULT now()
) RETURNS SETOF konektag.wallet_recharge_tax_rules
LANGUAGE plpgsql STABLE AS $$
DECLARE match_count INTEGER;
BEGIN
  SELECT count(*) INTO match_count
  FROM konektag.wallet_recharge_tax_rules r
  WHERE r.country_code = p_country_code AND r.currency = p_currency
    AND r.status = 'APPROVED' AND r.enabled
    AND r.valid_from <= p_at AND (r.valid_until IS NULL OR r.valid_until > p_at);
  IF match_count = 0 THEN RAISE EXCEPTION 'WALLET_RECHARGE_TAX_RULE_MISSING_OR_INACTIVE'; END IF;
  RETURN QUERY
    SELECT r.* FROM konektag.wallet_recharge_tax_rules r
    WHERE r.country_code = p_country_code AND r.currency = p_currency
      AND r.status = 'APPROVED' AND r.enabled
      AND r.valid_from <= p_at AND (r.valid_until IS NULL OR r.valid_until > p_at)
    ORDER BY r.tax_code;
END;
$$;

CREATE OR REPLACE FUNCTION konektag.resolve_wallet_recharge_limit_rule(
  p_country_code TEXT, p_currency TEXT, p_rail TEXT, p_provider TEXT,
  p_kyc_level TEXT, p_at TIMESTAMPTZ DEFAULT now()
) RETURNS konektag.wallet_recharge_limit_rules
LANGUAGE plpgsql STABLE AS $$
DECLARE result konektag.wallet_recharge_limit_rules; match_count INTEGER;
BEGIN
  SELECT count(*) INTO match_count
  FROM konektag.wallet_recharge_limit_rules r
  WHERE (r.country_code, r.currency, r.rail, r.provider, r.kyc_level) =
        (p_country_code, p_currency, p_rail, p_provider, p_kyc_level)
    AND r.status = 'APPROVED'
    AND r.valid_from <= p_at AND (r.valid_until IS NULL OR r.valid_until > p_at);
  IF match_count = 0 THEN RAISE EXCEPTION 'WALLET_RECHARGE_LIMIT_RULE_MISSING_OR_INACTIVE'; END IF;
  IF match_count > 1 THEN RAISE EXCEPTION 'WALLET_RECHARGE_LIMIT_RULE_AMBIGUOUS'; END IF;
  SELECT r INTO result
  FROM konektag.wallet_recharge_limit_rules r
  WHERE (r.country_code, r.currency, r.rail, r.provider, r.kyc_level) =
        (p_country_code, p_currency, p_rail, p_provider, p_kyc_level)
    AND r.status = 'APPROVED'
    AND r.valid_from <= p_at AND (r.valid_until IS NULL OR r.valid_until > p_at);
  RETURN result;
END;
$$;

CREATE TABLE konektag.wallet_recharge_rule_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_order_id UUID NOT NULL REFERENCES konektag.api_payment_orders(id),
  tax_rule_id UUID REFERENCES konektag.wallet_recharge_tax_rules(id),
  limit_rule_id UUID REFERENCES konektag.wallet_recharge_limit_rules(id),
  rule_snapshot JSONB NOT NULL CHECK (jsonb_typeof(rule_snapshot) = 'object'),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((tax_rule_id IS NOT NULL)::int + (limit_rule_id IS NOT NULL)::int = 1),
  UNIQUE (payment_order_id, tax_rule_id),
  UNIQUE (payment_order_id, limit_rule_id)
);

CREATE OR REPLACE FUNCTION konektag.prevent_applied_wallet_recharge_rule_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'wallet_recharge_rule_applications' THEN
    RAISE EXCEPTION 'WALLET_RECHARGE_RULE_APPLICATION_IMMUTABLE';
  END IF;
  IF TG_TABLE_NAME = 'wallet_recharge_tax_rules' AND EXISTS (
    SELECT 1 FROM konektag.wallet_recharge_rule_applications WHERE tax_rule_id = OLD.id
  ) THEN RAISE EXCEPTION 'APPLIED_WALLET_RECHARGE_TAX_RULE_IMMUTABLE';
  ELSIF TG_TABLE_NAME = 'wallet_recharge_limit_rules' AND EXISTS (
    SELECT 1 FROM konektag.wallet_recharge_rule_applications WHERE limit_rule_id = OLD.id
  ) THEN RAISE EXCEPTION 'APPLIED_WALLET_RECHARGE_LIMIT_RULE_IMMUTABLE';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER wallet_recharge_tax_rule_immutable_when_applied
BEFORE UPDATE OR DELETE ON konektag.wallet_recharge_tax_rules
FOR EACH ROW EXECUTE FUNCTION konektag.prevent_applied_wallet_recharge_rule_mutation();
CREATE TRIGGER wallet_recharge_limit_rule_immutable_when_applied
BEFORE UPDATE OR DELETE ON konektag.wallet_recharge_limit_rules
FOR EACH ROW EXECUTE FUNCTION konektag.prevent_applied_wallet_recharge_rule_mutation();
CREATE TRIGGER wallet_recharge_rule_application_immutable
BEFORE UPDATE OR DELETE ON konektag.wallet_recharge_rule_applications
FOR EACH ROW EXECUTE FUNCTION konektag.prevent_applied_wallet_recharge_rule_mutation();

COMMIT;
