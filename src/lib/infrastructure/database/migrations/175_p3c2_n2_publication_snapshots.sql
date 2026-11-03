-- P3-C2 — immutable public snapshot for the global N2 establishment page.
BEGIN;
CREATE TABLE IF NOT EXISTS konektag.merchant_n2_publication_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  published_by UUID REFERENCES konektag.users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_profile_id, version)
);
CREATE INDEX IF NOT EXISTS idx_merchant_n2_publication_live
  ON konektag.merchant_n2_publication_snapshots(merchant_profile_id, version DESC);
COMMIT;
