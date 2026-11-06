BEGIN;
-- 228 (API #24): public Marketplace projection. Additive only.
-- Writer: the konektag_360 publication worker (Frappe), through
-- konektag.marketplace_apply_publication(). Reader: konektag-api, SELECT only.
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

-- Idempotent, monotonic apply. The same event again is a no-op; an older
-- version is ignored; the same version with other content is refused.
-- Returns 'applied', 'duplicate' or 'stale'.
CREATE OR REPLACE FUNCTION konektag.marketplace_apply_publication(
  p_event_key TEXT, p_source_site TEXT, p_establishment_id UUID, p_version INTEGER,
  p_operation TEXT, p_slug TEXT, p_snapshot JSONB, p_capabilities TEXT[]
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE current_row konektag.marketplace_published_establishments%ROWTYPE;
BEGIN
  IF p_operation NOT IN ('Publish', 'Unpublish') THEN RAISE EXCEPTION 'invalid operation %', p_operation; END IF;
  SELECT * INTO current_row FROM konektag.marketplace_published_establishments
   WHERE establishment_id = p_establishment_id FOR UPDATE;
  IF FOUND THEN
    IF current_row.source_site <> p_source_site THEN RAISE EXCEPTION 'establishment owned by another site'; END IF;
    IF p_version < current_row.publication_version THEN RETURN 'stale'; END IF;
    IF p_version = current_row.publication_version THEN
      IF current_row.event_key = p_event_key THEN RETURN 'duplicate'; END IF;
      RAISE EXCEPTION 'conflicting event for version %', p_version;
    END IF;
  END IF;
  INSERT INTO konektag.marketplace_published_establishments AS t
    (establishment_id, source_site, slug, publication_version, status, event_key, snapshot, capabilities, delivered_at)
  VALUES (p_establishment_id, p_source_site, p_slug, p_version,
    CASE p_operation WHEN 'Publish' THEN 'Published' ELSE 'Unpublished' END, p_event_key,
    CASE p_operation WHEN 'Publish' THEN p_snapshot END,
    CASE p_operation WHEN 'Publish' THEN COALESCE(p_capabilities, '{}') ELSE '{}' END, now())
  ON CONFLICT (establishment_id) DO UPDATE SET
    slug = EXCLUDED.slug, publication_version = EXCLUDED.publication_version, status = EXCLUDED.status,
    event_key = EXCLUDED.event_key, snapshot = EXCLUDED.snapshot, capabilities = EXCLUDED.capabilities,
    delivered_at = EXCLUDED.delivered_at;
  RETURN 'applied';
END $$;
COMMIT;
