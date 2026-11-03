-- Retire merchant profile -> ERP establishment provisioning.
-- Historical schema dependency: idx_merchant_erpnext_estab.
-- RESTRICT rejects unexpected dependencies rather than deleting them silently.
BEGIN;
DROP INDEX IF EXISTS konektag.idx_merchant_erpnext_estab;
DELETE FROM konektag.outbox_events
WHERE event_type = 'MerchantEstablishmentProvisioningRequested';
ALTER TABLE konektag.merchant_profiles
  DROP COLUMN IF EXISTS provisioning_status RESTRICT,
  DROP COLUMN IF EXISTS provisioning_error RESTRICT,
  DROP COLUMN IF EXISTS provisioning_requested_at RESTRICT,
  DROP COLUMN IF EXISTS provisioning_completed_at RESTRICT,
  DROP COLUMN IF EXISTS erpnext_establishment_id RESTRICT;
COMMIT;
