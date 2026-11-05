BEGIN;
-- 227: preserve ERPNext site/product lineage for daily site-owned CPM exports.
-- API reads only this PostgreSQL projection and source registry.
CREATE TABLE IF NOT EXISTS konektag.cpm_source_sites (
  source_site TEXT PRIMARY KEY,
  billing_company TEXT NOT NULL UNIQUE,
  frappe_company TEXT NOT NULL,
  target_country CHAR(2) NOT NULL UNIQUE,
  currency CHAR(3) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO konektag.cpm_source_sites
 (source_site,billing_company,frappe_company,target_country,currency)
VALUES
 ('congo.erp.konektag.eu','Konektag Congo','konektag congo','CG','XAF'),
 ('europe.erp.konektag.eu','Konektag Europe','konektag europe','FR','EUR'),
 ('liban.erp.konektag.eu','Konektag Lebanon','konektag lebanon','LB','USD')
ON CONFLICT(source_site) DO NOTHING;
ALTER TABLE konektag.social_cpm_monthly_ranges
 ADD COLUMN IF NOT EXISTS source_site TEXT,
 ADD COLUMN IF NOT EXISTS item_code TEXT,
 ADD COLUMN IF NOT EXISTS source_document TEXT,
 ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE IF NOT EXISTS konektag.cpm_export_runs (
 id BIGSERIAL PRIMARY KEY,
 source_site TEXT NOT NULL,
 exported_rows INTEGER NOT NULL,
 status TEXT NOT NULL,
 finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS konektag.cpm_rate_history (
 id BIGSERIAL PRIMARY KEY,
 changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 month DATE NOT NULL,
 source_site TEXT,
 target_country CHAR(2),
 network TEXT,
 old_cpm_low NUMERIC(18,6),
 old_cpm_high NUMERIC(18,6),
 new_cpm_low NUMERIC(18,6),
 new_cpm_high NUMERIC(18,6),
 old_active BOOLEAN, new_active BOOLEAN
);
CREATE OR REPLACE FUNCTION konektag.record_cpm_rate_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(OLD.cpm_low,OLD.cpm_high,OLD.is_active)
    IS DISTINCT FROM ROW(NEW.cpm_low,NEW.cpm_high,NEW.is_active) THEN
  INSERT INTO konektag.cpm_rate_history
   (month,source_site,target_country,network,old_cpm_low,old_cpm_high,
    new_cpm_low,new_cpm_high,old_active,new_active)
  VALUES (OLD.month,OLD.source_site,OLD.target_country,OLD.network,
    OLD.cpm_low,OLD.cpm_high,NEW.cpm_low,NEW.cpm_high,OLD.is_active,NEW.is_active);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_cpm_rate_history ON konektag.social_cpm_monthly_ranges;
CREATE TRIGGER trg_cpm_rate_history
 AFTER UPDATE ON konektag.social_cpm_monthly_ranges
 FOR EACH ROW EXECUTE FUNCTION konektag.record_cpm_rate_change();
COMMIT;
