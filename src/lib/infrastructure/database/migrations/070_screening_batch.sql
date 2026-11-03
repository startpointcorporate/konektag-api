-- Migration 070 : Screening batch — injection manuelle de listes de sanctions
-- Permet d'importer des resultats de screening sans fournisseur temps reel
-- Les entrees positives creent automatiquement un ComplianceCase

BEGIN;

CREATE TABLE IF NOT EXISTS konektag.screening_batches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_ref       VARCHAR(100) NOT NULL UNIQUE,
    source          VARCHAR(100) NOT NULL,
    source_date     DATE NOT NULL,
    total_entries   INTEGER NOT NULL,
    positive_hits   INTEGER NOT NULL DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'IMPORTED'
                        CHECK (status IN ('IMPORTED', 'PROCESSING', 'PROCESSED', 'ERROR')),
    processed_by    UUID,
    processed_at    TIMESTAMPTZ,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS konektag.screening_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id        UUID NOT NULL REFERENCES konektag.screening_batches(id),
    entry_ref       VARCHAR(200) NOT NULL,
    full_name       VARCHAR(300) NOT NULL,
    match_type      VARCHAR(30) NOT NULL
                        CHECK (match_type IN ('sanction', 'pep', 'ubo', 'country_risk', 'adverse_media')),
    list_name       VARCHAR(200),
    match_score     INTEGER,
    raw_data        JSONB,
    linked_user_id  UUID,
    compliance_case_id UUID,
    status          VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'MATCHED_USER', 'NO_MATCH', 'IGNORED', 'CASE_CREATED')),
    reviewed_by     UUID,
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_screening_batch_ref ON konektag.screening_batches(batch_ref);
CREATE INDEX IF NOT EXISTS idx_screening_entries_batch ON konektag.screening_entries(batch_id);
CREATE INDEX IF NOT EXISTS idx_screening_entries_status ON konektag.screening_entries(status);
CREATE INDEX IF NOT EXISTS idx_screening_entries_user ON konektag.screening_entries(linked_user_id) WHERE linked_user_id IS NOT NULL;

COMMIT;
