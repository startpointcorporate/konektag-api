-- Migration 233 : journal of "Régulariser" actions run by Network operators from Frappe.
-- One row per executed action (site, user, option, reason, evidence, result). Additive and replayable.

BEGIN;

CREATE TABLE IF NOT EXISTS konektag.network_operation_regularizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_key VARCHAR(32) NOT NULL,
  operation_key VARCHAR(100) NOT NULL,
  option VARCHAR(20) NOT NULL CHECK (option IN ('verify', 'confirm_paid', 'confirm_failed')),
  operator_user VARCHAR(140) NOT NULL,
  operator_roles TEXT[] NOT NULL DEFAULT '{}',
  reason TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  result VARCHAR(30) NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_network_operation_regularizations_operation
  ON konektag.network_operation_regularizations (operation_key, created_at);

COMMIT;
