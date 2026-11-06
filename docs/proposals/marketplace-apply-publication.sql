-- PROPOSITION EN ATTENTE — non appliquée, non livrée.
-- Fonction d'écriture proposée au worker de publication konektag_360 (API #24).
-- Elle ne fait partie d'aucune migration. La session ERPNext décide du contrat
-- d'écriture ; une fois ce contrat livré, la lecture API s'y aligne et cette
-- proposition est soit reprise telle quelle dans une migration, soit retirée.
-- Prérequis : migration 228 (table konektag.marketplace_published_establishments).
BEGIN;
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
