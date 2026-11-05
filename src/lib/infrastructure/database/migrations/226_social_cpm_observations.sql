BEGIN;
-- Monthly operator-approved CPM ranges, indicative and non-guaranteed.
-- Kept distinct from ERPNext Item Prices (actual invoicing/quotes).
CREATE TABLE IF NOT EXISTS konektag.social_cpm_monthly_ranges (
  month DATE NOT NULL,
  billing_company TEXT NOT NULL CHECK (length(trim(billing_company)) BETWEEN 2 AND 140),
  target_country CHAR(2) NOT NULL CHECK (target_country ~ '^[A-Z]{2}$'),
  target_country_name TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('facebook','instagram','tiktok')),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  cpm_low NUMERIC(18,6) NOT NULL CHECK (cpm_low > 0),
  cpm_high NUMERIC(18,6) NOT NULL CHECK (cpm_high >= cpm_low),
  source_file_sha256 CHAR(64) NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (month,target_country,network)
);
CREATE INDEX IF NOT EXISTS social_cpm_monthly_ranges_company_month_idx
  ON konektag.social_cpm_monthly_ranges (billing_company,month DESC,target_country);
-- A month of country allocations must not be split between companies.
-- Enforced by the importer transaction as well as read-side fail-closed checks.
COMMIT;
