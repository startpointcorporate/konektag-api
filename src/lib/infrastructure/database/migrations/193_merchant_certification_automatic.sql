BEGIN;

-- Merchant certification is earned automatically from completed merchant transactions.
-- KYB documents/approval remain a separate merchant-validation concern.
ALTER TABLE konektag.merchant_profiles DROP CONSTRAINT IF EXISTS merchant_profiles_certification_status_check;
ALTER TABLE konektag.merchant_profiles ADD CONSTRAINT merchant_profiles_certification_status_check
  CHECK (certification_status IN ('NON_CERTIFIED', 'VALIDATED'));

CREATE OR REPLACE FUNCTION konektag.count_merchant_received_transactions(p_merchant_profile_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*)::integer INTO v_count
  FROM konektag.financial_transactions ft
  WHERE ft.merchant_profile_id = p_merchant_profile_id
    AND ft.status = 'completed'
    AND ft.transaction_type IN ('qr_payment', 'api_payment', 'consumption', 'link_payment');
  RETURN v_count;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION konektag.auto_certify_merchant_after_completed_transaction()
RETURNS trigger AS $$
BEGIN
  IF NEW.merchant_profile_id IS NOT NULL
     AND NEW.status = 'completed'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    UPDATE konektag.merchant_profiles mp
       SET certification_status = 'VALIDATED',
           certification_reviewed_at = COALESCE(mp.certification_reviewed_at, now()),
           certification_reviewed_by = NULL,
           updated_at = now(),
           version = version + 1
     WHERE mp.id = NEW.merchant_profile_id
       AND mp.certification_status <> 'VALIDATED'
       AND konektag.count_merchant_received_transactions(NEW.merchant_profile_id) >= 10;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_certify_merchant ON konektag.financial_transactions;
CREATE TRIGGER trg_auto_certify_merchant
AFTER INSERT OR UPDATE OF status ON konektag.financial_transactions
FOR EACH ROW EXECUTE FUNCTION konektag.auto_certify_merchant_after_completed_transaction();

-- Backfill merchants that already earned certification.
UPDATE konektag.merchant_profiles mp
   SET certification_status = 'VALIDATED',
       certification_reviewed_at = COALESCE(mp.certification_reviewed_at, now()),
       certification_reviewed_by = NULL,
       updated_at = now(),
       version = version + 1
 WHERE mp.certification_status <> 'VALIDATED'
   AND konektag.count_merchant_received_transactions(mp.id) >= 10;

COMMIT;
