BEGIN;
-- 228 (API #24): public Marketplace projection. Additive only.
-- Reader: konektag-api, SELECT only. Writer: the konektag_360 publication
-- worker (not delivered). Its write contract is a pending proposal kept out of
-- this migration: docs/proposals/marketplace-apply-publication.sql.
-- Align this schema with the PostgreSQL contract the ERPNext session delivers
-- before applying it on DESIGN.
-- One row per establishment, mirroring a delivered Merchant Publication Job:
-- event_key = SHA-256(source_site:establishment_id:version), the snapshot is
-- konektag_360.domain.snapshot() for Publish and NULL (tombstone) for Unpublish.
CREATE TABLE IF NOT EXISTS konektag.marketplace_published_establishments (
  establishment_id UUID PRIMARY KEY,
  source_site TEXT NOT NULL CHECK (source_site ~ '^[a-z0-9.-]+$'),
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 160),
  publication_version INTEGER NOT NULL CHECK (publication_version > 0),
  status TEXT NOT NULL CHECK (status IN ('Published', 'Unpublished')),
  event_key CHAR(64) NOT NULL UNIQUE CHECK (event_key ~ '^[0-9a-f]{64}$'),
  snapshot JSONB,
  -- Transactional capabilities published for this establishment.
  capabilities TEXT[] NOT NULL DEFAULT '{}' CHECK (capabilities <@ ARRAY['restaurant', 'hotel']::TEXT[]),
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'Published') = (snapshot IS NOT NULL)),
  CHECK (status = 'Published' OR capabilities = '{}')
);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_published_establishments_slug
  ON konektag.marketplace_published_establishments (slug);

COMMIT;
