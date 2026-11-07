#!/usr/bin/env bash
# Konektag: install/verify 3 independent daily ERPNext -> PostgreSQL CPM exports.
# Run from Ubuntu VM: bash install_konektag_cpm.sh --check | --install | --run-all
set -Eeuo pipefail
MODE="${1:---check}"
case "$MODE" in --check|--install|--run-all) ;; *) echo "Usage: $0 --check|--install|--run-all" >&2; exit 2;; esac
HOST="${KONEKTAG_K3S_HOST:-konektag-core}"
SSH_TMP="/tmp/konektag-cpm-setup-$$.sh"
trap 'ssh "$HOST" "rm -f $SSH_TMP" >/dev/null 2>&1 || true' EXIT
# Send exactly this script to VPS and run its embedded payload. SSH is the only external dependency on the VM.
ssh "$HOST" "cat > '$SSH_TMP' && chmod 700 '$SSH_TMP'" <<'REMOTE'
#!/usr/bin/env bash
set -Eeuo pipefail
MODE="${1:---check}"
BASE=/opt/konektag-cpm
NS_PG=konektag-data
NS_ERP=konektag-common
PG_POD=postgres-0
ERP_DEPLOY=deployment/konektag-erpnext-gunicorn
PSQL=(sudo -n k3s kubectl -n "$NS_PG" exec -i "$PG_POD" -- psql -X -q -v ON_ERROR_STOP=1 -U postgres -d konektag)
K=(sudo -n k3s kubectl)
mkdir -p "$BASE"
cat > "$BASE/export.py" <<'PY'
#!/usr/bin/env python3
"""Three site-scoped, read-only Frappe exports into one PostgreSQL projection.
No network secrets, no Item Price writes. Used by root cron on the K3s VPS.
"""
import argparse, decimal, hashlib, json, re, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

SITES = {
    "congo": ("congo.erp.konektag.eu", "konektag congo", "Konektag Congo", "CG", "XAF"),
    "europe": ("europe.erp.konektag.eu", "konektag europe", "Konektag Europe", "FR", "EUR"),
    "lebanon": ("liban.erp.konektag.eu", "konektag lebanon", "Konektag Lebanon", "LB", "USD"),
}
NETWORKS = {"facebook", "instagram", "tiktok"}
FIELDS = ["name", "rate_key", "company", "item_code", "target_country", "network", "currency", "cpm_low", "cpm_high", "reference_month", "is_active", "modified"]

def run(cmd, stdin=None):
    p = subprocess.run(cmd, input=stdin, text=True, capture_output=True, timeout=90)
    if p.returncode:
        raise RuntimeError(f"command failed ({p.returncode}): {p.stderr.strip()[:1200]} {p.stdout.strip()[:600]}")
    return p.stdout.strip()

def bench(site, doctype, filters, fields):
    kwargs = {"doctype": doctype, "filters": filters, "fields": fields, "limit_page_length": 1000}
    out = run(["sudo", "-n", "k3s", "kubectl", "-n", "konektag-common", "exec",
       "deployment/konektag-erpnext-gunicorn", "--", "bench", "--site", site,
       "execute", "frappe.get_all", "--kwargs", json.dumps(kwargs, separators=(',',':'))])
    if not out:
        return []
    result = json.loads(out.splitlines()[-1])
    if not isinstance(result,list):
        raise RuntimeError("Unexpected frappe.get_all response")
    if len(result) >= 1000:
        raise RuntimeError("Pagination limit reached; refuse partial export")
    return result

def quote(v):
    return "'" + str(v).replace("'", "''") + "'"

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('site', choices=sorted(SITES))
    ap.add_argument('--check', action='store_true')
    args=ap.parse_args()
    site, company, owner, country, currency=SITES[args.site]
    docs=bench(site, "Marketing CPM Rate", {"target_country":country}, FIELDS)
    if not docs:
        raise RuntimeError(f"No CPM rows returned for {site} -- not publishing an empty export")
    companies=bench(site, "Company", {"name":company}, ["name","default_currency"])
    if len(companies)!=1 or companies[0]["default_currency"]!=currency:
        raise RuntimeError(f"Company/currency mismatch: {site}")
    now=datetime.now(timezone.utc).date()
    seen=set(); validated=[]
    for row in docs:
        n=str(row["network"]).lower(); code=str(row["item_code"]); month=str(row["reference_month"])[:7]
        if n not in NETWORKS or row["company"]!=company or row["currency"]!=currency or row["target_country"]!=country:
            raise RuntimeError(f"Wrong site market: {row.get('name')}")
        if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month) or month>now.strftime('%Y-%m'):
            raise RuntimeError(f"Invalid/future month: {month}")
        if code!=f"KTG-BOOST-{n.upper()}-{country}" or row['rate_key']!=f"{month}-{country}-{n}" or row['name']!=row['rate_key']:
            raise RuntimeError(f"Broken product mapping: {row.get('name')}")
        low=decimal.Decimal(str(row['cpm_low'])); high=decimal.Decimal(str(row['cpm_high']))
        if not (low.is_finite() and high.is_finite()) or low<=0 or high<low or high>decimal.Decimal('1000000000'):
            raise RuntimeError(f"Invalid CPM bounds: {row.get('name')}")
        if currency=='XAF' and (low!=low.to_integral_value() or high!=high.to_integral_value()):
            raise RuntimeError('XAF decimal mismatch')
        key=(month,n)
        if key in seen: raise RuntimeError(f"Duplicate {key}")
        seen.add(key)
        validated.append((row, n, code, month, low, high))
    # Validate all referenced Items before any write; never create products from exporter.
    items=bench(site,"Item",{"item_code":["in",[v[2] for v in validated]]},["item_code","is_stock_item","disabled","stock_uom"])
    by_code={i['item_code']:i for i in items}
    for row,n,code,month,low,high in validated:
        item=by_code.get(code)
        if not item or item['is_stock_item'] or item['disabled'] or item['stock_uom']!='Nos':
            raise RuntimeError(f"Missing/invalid Item {code}")
    print(f"{args.site}: {len(validated)} rows validated for {site}", flush=True)
    if args.check:return
    sql=["BEGIN;", "SELECT pg_advisory_xact_lock(hashtext('konektag-cpm-export'));", "SET LOCAL lock_timeout = '10s';"]
    # Database-side source registry prevents one site from impersonating another.
    sql.append("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM konektag.cpm_source_sites WHERE source_site="+quote(site)+" AND billing_company="+quote(owner)+" AND frappe_company="+quote(company)+" AND target_country="+quote(country)+" AND currency="+quote(currency)+" AND is_active) THEN RAISE EXCEPTION 'CPM_SOURCE_SITE_NOT_AUTHORIZED'; END IF; END $$;")
    for row,n,code,month,low,high in validated:
        canonical=json.dumps({"site":site,"name":row['name'],"company":company,"item":code,"country":country,"network":n,"currency":currency,"month":month,"low":str(low),"high":str(high),"active":bool(row['is_active'])},sort_keys=True,separators=(',',':'))
        sha=hashlib.sha256(canonical.encode()).hexdigest()
        vals=[month+'-01',owner,country,{'CG':'Congo','FR':'France','LB':'Liban'}[country],n,currency,str(low),str(high),sha,site,code,row['name'],bool(row['is_active'])]
        expr=','.join(('TRUE' if v else 'FALSE') if type(v) is bool else quote(v) for v in vals)
        sql.append("""INSERT INTO konektag.social_cpm_monthly_ranges
(month,billing_company,target_country,target_country_name,network,currency,cpm_low,cpm_high,source_file_sha256,source_site,item_code,source_document,is_active,imported_at)
VALUES ("""+expr+""",now()) ON CONFLICT (month,target_country,network) DO UPDATE SET
billing_company=EXCLUDED.billing_company,target_country_name=EXCLUDED.target_country_name,
currency=EXCLUDED.currency,cpm_low=EXCLUDED.cpm_low,cpm_high=EXCLUDED.cpm_high,
source_file_sha256=EXCLUDED.source_file_sha256,source_site=EXCLUDED.source_site,
item_code=EXCLUDED.item_code,source_document=EXCLUDED.source_document,
is_active=EXCLUDED.is_active,imported_at=now()
WHERE konektag.social_cpm_monthly_ranges.source_site=EXCLUDED.source_site
AND (konektag.social_cpm_monthly_ranges.cpm_low,konektag.social_cpm_monthly_ranges.cpm_high,konektag.social_cpm_monthly_ranges.is_active,konektag.social_cpm_monthly_ranges.source_file_sha256)
IS DISTINCT FROM (EXCLUDED.cpm_low,EXCLUDED.cpm_high,EXCLUDED.is_active,EXCLUDED.source_file_sha256);
""")
        # Ensure collisions with another site fail rather than silently do nothing.
        sql.append("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM konektag.social_cpm_monthly_ranges WHERE month="+quote(month+'-01')+" AND target_country="+quote(country)+" AND network="+quote(n)+" AND source_site="+quote(site)+") THEN RAISE EXCEPTION 'CPM_SOURCE_CONFLICT'; END IF; END $$;")
    sql.append("INSERT INTO konektag.cpm_export_runs(source_site,exported_rows,status) VALUES ("+quote(site)+","+str(len(validated))+",'success');")
    sql.append('COMMIT;')
    out=run(["sudo","-n","k3s","kubectl","-n","konektag-data","exec","-i","postgres-0","--","psql","-X","-q","-v","ON_ERROR_STOP=1","-U","postgres","-d","konektag"], '\n'.join(sql)+'\n')
    print(f"{site}: {len(validated)} CPM exported to PostgreSQL",flush=True)

if __name__=='__main__':
    try:main()
    except Exception as e:
        print('ERROR:',e,file=sys.stderr)
        sys.exit(1)
PY
chmod 750 "$BASE/export.py"
cat > "$BASE/schema.sql" <<'SQL'
BEGIN;
CREATE TABLE IF NOT EXISTS konektag.cpm_source_sites (
 source_site TEXT PRIMARY KEY,
 billing_company TEXT NOT NULL UNIQUE,
 frappe_company TEXT NOT NULL,
 target_country CHAR(2) NOT NULL UNIQUE,
 currency CHAR(3) NOT NULL,
 is_active BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO konektag.cpm_source_sites(source_site,billing_company,frappe_company,target_country,currency)
VALUES
 ('congo.erp.konektag.eu','Konektag Congo','konektag congo','CG','XAF'),
 ('europe.erp.konektag.eu','Konektag Europe','konektag europe','FR','EUR'),
 ('liban.erp.konektag.eu','Konektag Lebanon','konektag lebanon','LB','USD')
ON CONFLICT (source_site) DO NOTHING;
ALTER TABLE konektag.social_cpm_monthly_ranges ADD COLUMN IF NOT EXISTS source_site TEXT;
ALTER TABLE konektag.social_cpm_monthly_ranges ADD COLUMN IF NOT EXISTS item_code TEXT;
ALTER TABLE konektag.social_cpm_monthly_ranges ADD COLUMN IF NOT EXISTS source_document TEXT;
ALTER TABLE konektag.social_cpm_monthly_ranges ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE IF NOT EXISTS konektag.cpm_export_runs (
 id BIGSERIAL PRIMARY KEY, source_site TEXT NOT NULL,
 exported_rows INTEGER NOT NULL, status TEXT NOT NULL,
 finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS konektag.cpm_rate_history (
 id BIGSERIAL PRIMARY KEY,
 changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 month DATE NOT NULL, source_site TEXT,
 target_country CHAR(2), network TEXT,
 old_cpm_low NUMERIC(18,6), old_cpm_high NUMERIC(18,6),
 new_cpm_low NUMERIC(18,6), new_cpm_high NUMERIC(18,6),
 old_active BOOLEAN, new_active BOOLEAN
);
CREATE OR REPLACE FUNCTION konektag.record_cpm_rate_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(OLD.cpm_low,OLD.cpm_high,OLD.is_active) IS DISTINCT FROM ROW(NEW.cpm_low,NEW.cpm_high,NEW.is_active) THEN
  INSERT INTO konektag.cpm_rate_history(month,source_site,target_country,network,old_cpm_low,old_cpm_high,new_cpm_low,new_cpm_high,old_active,new_active)
  VALUES(OLD.month,OLD.source_site,OLD.target_country,OLD.network,OLD.cpm_low,OLD.cpm_high,NEW.cpm_low,NEW.cpm_high,OLD.is_active,NEW.is_active);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_cpm_rate_history ON konektag.social_cpm_monthly_ranges;
CREATE TRIGGER trg_cpm_rate_history AFTER UPDATE ON konektag.social_cpm_monthly_ranges FOR EACH ROW EXECUTE FUNCTION konektag.record_cpm_rate_change();
COMMIT;
SQL
if [[ "$MODE" == '--check' ]]; then
 echo '=== AUDIT (aucune ecriture PG/cron) ==='
 "${K[@]}" -n "$NS_ERP" get deployment konektag-erpnext-gunicorn >/dev/null
 "${K[@]}" -n "$NS_PG" get pod "$PG_POD" >/dev/null
 python3 "$BASE/export.py" congo --check
 python3 "$BASE/export.py" europe --check
 python3 "$BASE/export.py" lebanon --check
 echo 'AUDIT OK - lancez --install pour activer les cron et la projection'
 exit 0
fi
if [[ "$MODE" == '--install' ]]; then
 echo '=== CREATION SCHEMA / MAPPING PG ==='
 "${PSQL[@]}" < "$BASE/schema.sql"
 echo '=== PREMIER EXPORT 3 SITES ==='
 for site in congo europe lebanon; do python3 "$BASE/export.py" "$site"; done
 cat > /etc/cron.d/konektag-cpm <<'CRON'
# Konektag: daily per-site ERPNext source -> PostgreSQL CPM projection (UTC)
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CRON_TZ=UTC
10 2 * * * root /usr/bin/flock -n /run/konektag-cpm-congo.lock /usr/bin/python3 /opt/konektag-cpm/export.py congo >> /var/log/konektag-cpm/congo.log 2>&1
20 2 * * * root /usr/bin/flock -n /run/konektag-cpm-europe.lock /usr/bin/python3 /opt/konektag-cpm/export.py europe >> /var/log/konektag-cpm/europe.log 2>&1
30 2 * * * root /usr/bin/flock -n /run/konektag-cpm-lebanon.lock /usr/bin/python3 /opt/konektag-cpm/export.py lebanon >> /var/log/konektag-cpm/lebanon.log 2>&1
CRON
 chmod 644 /etc/cron.d/konektag-cpm
 mkdir -p /var/log/konektag-cpm
 cat > /etc/logrotate.d/konektag-cpm <<'LOG'
/var/log/konektag-cpm/*.log {
 weekly
 rotate 8
 compress
 missingok
 notifempty
 copytruncate
}
LOG
 echo '=== INSTALLE: 3 cron quotidiens + logs + historique + export initial ==='
 "${PSQL[@]}" -c "SELECT source_site,exported_rows,finished_at FROM konektag.cpm_export_runs ORDER BY finished_at DESC LIMIT 3;"
 exit 0
fi
if [[ "$MODE" == '--run-all' ]]; then
 for site in congo europe lebanon; do python3 "$BASE/export.py" "$site"; done
 "${PSQL[@]}" -c "SELECT source_site,exported_rows,finished_at FROM konektag.cpm_export_runs ORDER BY finished_at DESC LIMIT 3;"
fi
REMOTE
ssh "$HOST" "sudo bash '$SSH_TMP' '$MODE'"
