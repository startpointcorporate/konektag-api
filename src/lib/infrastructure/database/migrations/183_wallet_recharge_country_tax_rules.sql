BEGIN;

CREATE TABLE IF NOT EXISTS konektag.wallet_recharge_tax_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code VARCHAR(2) NOT NULL,
  tax_name TEXT NOT NULL DEFAULT 'TVA',
  rate_basis_points INTEGER NOT NULL CHECK (rate_basis_points BETWEEN 0 AND 10000),
  enabled BOOLEAN NOT NULL DEFAULT true,
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_recharge_tax_rules_active_identity
  ON konektag.wallet_recharge_tax_rules(country_code, valid_from);

-- France: standard VAT rate for the taxable K purchase service.
INSERT INTO konektag.wallet_recharge_tax_rules
  (country_code, tax_name, rate_basis_points, enabled, valid_from)
VALUES ('FR', 'TVA', 2000, true, DATE '2026-01-01')
ON CONFLICT (country_code, valid_from) DO UPDATE
SET tax_name = EXCLUDED.tax_name,
    rate_basis_points = EXCLUDED.rate_basis_points,
    enabled = EXCLUDED.enabled,
    updated_at = now();

COMMIT;
