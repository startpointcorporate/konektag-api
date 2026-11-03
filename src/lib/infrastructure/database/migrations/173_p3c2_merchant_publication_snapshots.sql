-- P3-C2 — immutable public snapshots for explicit Draft -> Live publication
BEGIN;
CREATE TABLE IF NOT EXISTS konektag.merchant_publication_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_profile_id UUID NOT NULL REFERENCES konektag.merchant_profiles(id) ON DELETE CASCADE,
  activity_code VARCHAR(32) NOT NULL CHECK (activity_code IN ('Restaurant','Hotel','Commerce')),
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  published_by UUID REFERENCES konektag.users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_profile_id, activity_code, version)
);
CREATE INDEX IF NOT EXISTS idx_merchant_publication_live
  ON konektag.merchant_publication_snapshots(merchant_profile_id, activity_code, version DESC);
COMMIT;
