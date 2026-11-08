BEGIN;
-- 229 (API #31): tenant-scoped public team projection and secured writer.
CREATE TABLE IF NOT EXISTS konektag.tenant_members_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL CHECK (tenant_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  source_site TEXT NOT NULL CHECK (source_site ~ '^[a-z0-9]+([.-][a-z0-9]+)*$'),
  source_company TEXT NOT NULL CHECK (length(source_company) BETWEEN 1 AND 255),
  db_role NAME NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Active','Revoked')),
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,source_site,source_company), UNIQUE (id,tenant_id),
  CHECK ((status='Revoked')=(revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS tenant_members_sites_active_tenant ON konektag.tenant_members_sites(tenant_id) WHERE status='Active';

CREATE TABLE IF NOT EXISTS konektag.tenant_members (
  tenant_id TEXT NOT NULL,
  team_member_id UUID NOT NULL,
  tenant_members_site_id UUID NOT NULL,
  public_slug TEXT NOT NULL CHECK (public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(public_slug)<=160),
  publication_version BIGINT NOT NULL CHECK (publication_version>0),
  status TEXT NOT NULL CHECK (status IN ('Published','Unpublished')),
  event_key CHAR(64) NOT NULL UNIQUE CHECK (event_key ~ '^[0-9a-f]{64}$'),
  snapshot JSONB, delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,team_member_id),
  FOREIGN KEY (tenant_members_site_id,tenant_id) REFERENCES konektag.tenant_members_sites(id,tenant_id),
  UNIQUE (tenant_id,public_slug), CHECK ((status='Published')=(snapshot IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS tenant_members_public_order ON konektag.tenant_members
 (tenant_id,((COALESCE(snapshot->>'display_order','0'))::integer),((COALESCE(snapshot->>'display_name','')) COLLATE "C"),team_member_id)
 WHERE status='Published';

CREATE OR REPLACE FUNCTION konektag.apply_tenant_member_publication(
 p_tenant_id TEXT,p_source_site TEXT,p_source_company TEXT,p_team_member_id UUID,p_publication_version BIGINT,
 p_operation TEXT,p_event_key TEXT,p_schema_version INTEGER,p_public_slug TEXT,p_snapshot JSONB
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,konektag AS $$
DECLARE v_site konektag.tenant_members_sites%ROWTYPE; v_current konektag.tenant_members%ROWTYPE; v_expected TEXT;
BEGIN
 IF p_schema_version IS DISTINCT FROM 1 OR p_operation IS NULL OR p_operation NOT IN ('Publish','Unpublish')
    OR p_publication_version IS NULL OR p_publication_version<=0 OR p_team_member_id IS NULL
    OR p_tenant_id IS NULL OR p_tenant_id!~'^[a-z0-9]+(-[a-z0-9]+)*$'
    OR p_source_site IS NULL OR p_source_site!~'^[a-z0-9]+([.-][a-z0-9]+)*$'
    OR p_source_company IS NULL OR length(p_source_company) NOT BETWEEN 1 AND 255
    OR p_public_slug IS NULL OR p_public_slug!~'^[a-z0-9]+(-[a-z0-9]+)*$' OR length(p_public_slug)>160
    OR p_event_key IS NULL OR p_event_key!~'^[0-9a-f]{64}$'
    OR (p_operation='Publish')<>(p_snapshot IS NOT NULL) THEN RAISE EXCEPTION 'INVALID_ENVELOPE' USING ERRCODE='22023'; END IF;
 IF p_snapshot IS NOT NULL AND (jsonb_typeof(p_snapshot)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_snapshot) k WHERE k<>ALL(ARRAY['first_name','last_name','display_name','job_title','team_label','country_code','city_name','short_description','long_description','photo','public_email','public_phone','public_whatsapp','links','display_order']))) THEN RAISE EXCEPTION 'INVALID_ENVELOPE' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_site FROM konektag.tenant_members_sites WHERE tenant_id=p_tenant_id AND source_site=p_source_site AND source_company=p_source_company AND status='Active' AND db_role=session_user;
 IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 v_expected:=encode(sha256(convert_to('team:'||p_tenant_id||':'||p_source_site||':'||p_source_company||':'||p_team_member_id||':'||p_publication_version,'UTF8')),'hex');
 IF p_event_key<>v_expected THEN RAISE EXCEPTION 'INVALID_ENVELOPE' USING ERRCODE='22023'; END IF;
 -- A row lock cannot serialize the first publication because no member row exists yet.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id||':'||p_team_member_id::text,0));
 SELECT * INTO v_current FROM konektag.tenant_members WHERE tenant_id=p_tenant_id AND team_member_id=p_team_member_id FOR UPDATE;
 IF FOUND THEN
  IF v_current.tenant_members_site_id<>v_site.id THEN RAISE EXCEPTION 'OWNER_CONFLICT' USING ERRCODE='23505'; END IF;
  IF p_publication_version<v_current.publication_version THEN RETURN 'stale'; END IF;
  IF p_publication_version=v_current.publication_version THEN
   IF p_event_key=v_current.event_key AND p_public_slug=v_current.public_slug AND p_snapshot IS NOT DISTINCT FROM v_current.snapshot THEN RETURN 'duplicate'; END IF;
   RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='23505';
  END IF;
  IF p_public_slug<>v_current.public_slug THEN RAISE EXCEPTION 'INVALID_ENVELOPE' USING ERRCODE='22023'; END IF;
  UPDATE konektag.tenant_members SET publication_version=p_publication_version,status=CASE p_operation WHEN 'Publish' THEN 'Published' ELSE 'Unpublished' END,event_key=p_event_key,snapshot=p_snapshot,delivered_at=now() WHERE tenant_id=p_tenant_id AND team_member_id=p_team_member_id;
 ELSE
  INSERT INTO konektag.tenant_members(tenant_id,team_member_id,tenant_members_site_id,public_slug,publication_version,status,event_key,snapshot)
   VALUES(p_tenant_id,p_team_member_id,v_site.id,p_public_slug,p_publication_version,CASE p_operation WHEN 'Publish' THEN 'Published' ELSE 'Unpublished' END,p_event_key,p_snapshot);
 END IF;
 RETURN 'applied';
END $$;
REVOKE ALL ON FUNCTION konektag.apply_tenant_member_publication(TEXT,TEXT,TEXT,UUID,BIGINT,TEXT,TEXT,INTEGER,TEXT,JSONB) FROM PUBLIC;
COMMIT;
