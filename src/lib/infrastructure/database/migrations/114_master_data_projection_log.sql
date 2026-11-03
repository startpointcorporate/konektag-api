-- Technical audit state for Frappe Foundation to payment-runtime master data pulls.
BEGIN;

CREATE TABLE IF NOT EXISTS konektag.master_data_projections (
  source_type VARCHAR(40) NOT NULL,
  source_code VARCHAR(100) NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  projection_status VARCHAR(20) NOT NULL CHECK (projection_status IN ('PROJECTED', 'FAILED')),
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_message TEXT,
  PRIMARY KEY (source_type, source_code)
);

COMMIT;
