#!/usr/bin/env bash
set -euo pipefail

HOST="konektag-core"
NS="konektag-common"
POD="deployment/konektag-erpnext-gunicorn"

ssh "$HOST" \
  "sudo k3s kubectl -n $NS exec -i $POD -- bash -s" <<'REMOTE'

set -euo pipefail
cd /home/frappe/frappe-bench

create_item() {
    local site="$1"
    local company="$2"
    local code="$3"
    local label="$4"

    echo "=== $site : $code ==="

    # Ne pas créer de doublon.
    existing=$(bench --site "$site" execute frappe.db.exists \
      --kwargs "{\"dt\":\"Item\",\"dn\":\"$code\"}" 2>&1)

    if [[ "$existing" != "None" && "$existing" != "null" && -n "$existing" ]]; then
        echo "EXISTE : $code"
        return
    fi

    bench --site "$site" execute frappe.client.insert \
      --kwargs "{
        \"doc\": {
          \"doctype\": \"Item\",
          \"item_code\": \"$code\",
          \"item_name\": \"$label\",
          \"item_group\": \"Services\",
          \"stock_uom\": \"Nos\",
          \"is_stock_item\": 0,
          \"disabled\": 0,
          \"item_defaults\": [
            {
              \"company\": \"$company\"
            }
          ]
        }
      }"

    echo "CRÉÉ : $code"
}

# Vérification des prérequis sur chaque site.
for site in \
    congo.erp.konektag.eu \
    europe.erp.konektag.eu \
    liban.erp.konektag.eu
do
    for spec in "Item Group:Services" "UOM:Nos"; do
        doctype="${spec%%:*}"
        name="${spec#*:}"

        result=$(bench --site "$site" execute frappe.db.exists \
          --kwargs "{\"dt\":\"$doctype\",\"dn\":\"$name\"}")

        if [[ "$result" == "None" || "$result" == "null" || -z "$result" ]]; then
            echo "ERREUR : $doctype '$name' absent sur $site"
            exit 1
        fi
    done
done

# CONGO
create_item "congo.erp.konektag.eu" "konektag congo" \
  "KTG-BOOST-FACEBOOK-CG" "Promotion Facebook Congo"

create_item "congo.erp.konektag.eu" "konektag congo" \
  "KTG-BOOST-INSTAGRAM-CG" "Promotion Instagram Congo"

# EUROPE
create_item "europe.erp.konektag.eu" "konektag europe" \
  "KTG-BOOST-FACEBOOK-FR" "Promotion Facebook France"

create_item "europe.erp.konektag.eu" "konektag europe" \
  "KTG-BOOST-INSTAGRAM-FR" "Promotion Instagram France"

# LIBAN
create_item "liban.erp.konektag.eu" "konektag lebanon" \
  "KTG-BOOST-FACEBOOK-LB" "Promotion Facebook Liban"

create_item "liban.erp.konektag.eu" "konektag lebanon" \
  "KTG-BOOST-INSTAGRAM-LB" "Promotion Instagram Liban"

create_item "liban.erp.konektag.eu" "konektag lebanon" \
  "KTG-BOOST-TIKTOK-LB" "Promotion TikTok Liban"

echo "=== INITIALISATION TERMINÉE ==="

REMOTE
