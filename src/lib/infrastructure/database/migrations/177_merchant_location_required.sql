-- Merchant location invariant: a MERCHANT establishment always has a non-blank
-- country and city (Marketplace URLs, publication and public QR codes depend on it).
--
-- Not a plain NOT NULL: NETWORK beneficiaries are technical payment profiles
-- provisioned with a country but without a city or Marketplace presence.
-- Soft-deleted rows are exempt; restoring one re-checks the constraint.
BEGIN;

ALTER TABLE konektag.merchant_profiles
  DROP CONSTRAINT IF EXISTS merchant_profiles_merchant_location_required,
  ADD CONSTRAINT merchant_profiles_merchant_location_required
    CHECK (
      deleted_at IS NOT NULL
      OR beneficiary_type <> 'MERCHANT'
      OR (btrim(COALESCE(country, '')) <> '' AND btrim(COALESCE(city, '')) <> '')
    ) NOT VALID;

-- Enforced for every new write immediately. Existing rows are validated here when
-- they already comply; no placeholder location is ever written to make them comply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM konektag.merchant_profiles
     WHERE deleted_at IS NULL
       AND beneficiary_type = 'MERCHANT'
       AND (btrim(COALESCE(country, '')) = '' OR btrim(COALESCE(city, '')) = '')
  ) THEN
    ALTER TABLE konektag.merchant_profiles VALIDATE CONSTRAINT merchant_profiles_merchant_location_required;
  ELSE
    RAISE NOTICE 'merchant_profiles_merchant_location_required left NOT VALID: active MERCHANT rows without country/city must be corrected, then VALIDATE CONSTRAINT';
  END IF;
END $$;

COMMIT;
