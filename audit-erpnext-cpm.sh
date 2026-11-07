#!/usr/bin/env bash
set -euo pipefail

# Usage:
# ERP_NAMESPACE=konektag-common \
# ERP_POD=nom-du-pod-backend \
# ./audit-erpnext-cpm.sh

HOST="${KONEKTAG_K3S_HOST:-konektag-core}"
NAMESPACE="${ERP_NAMESPACE:-konektag-common}"
POD="${ERP_POD:?Définir ERP_POD avec le nom du pod Frappe backend}"

echo "========================================="
echo " AUDIT KONEKTAG - ERPNext multi-sites"
echo "========================================="

ssh "$HOST" \
  "sudo k3s kubectl -n $NAMESPACE exec -i $POD -- bash -s" <<'REMOTE'

set -euo pipefail

cd /home/frappe/frappe-bench

echo ""
echo "=== SITES FRAPPE DISPONIBLES ==="

bench list-sites

echo ""
echo "=== AUDIT DES SITES ==="

for site in $(bench list-sites | awk 'NF==1 {print $1}'); do

  echo ""
  echo "========================================="
  echo "SITE : $site"
  echo "========================================="

  echo ""
  echo "--- SOCIETES ---"

  bench --site "$site" execute frappe.get_all \
    --kwargs '{
      "doctype": "Company",
      "fields": [
        "name",
        "abbr",
        "country",
        "default_currency"
      ],
      "limit_page_length": 100
    }'

  echo ""
  echo "--- PRODUITS KONEKTAG BOOST ---"

  bench --site "$site" execute frappe.get_all \
    --kwargs '{
      "doctype": "Item",
      "filters": [
        ["item_code", "like", "KTG-BOOST-%"]
      ],
      "fields": [
        "item_code",
        "item_name",
        "item_group",
        "is_stock_item",
        "disabled"
      ],
      "limit_page_length": 100
    }'

  echo ""
  echo "--- LISTES DE PRIX ---"

  bench --site "$site" execute frappe.get_all \
    --kwargs '{
      "doctype": "Price List",
      "fields": [
        "name",
        "currency",
        "selling",
        "enabled"
      ],
      "limit_page_length": 100
    }'

  echo ""
  echo "--- PRIX DES PRODUITS BOOST ---"

  bench --site "$site" execute frappe.get_all \
    --kwargs '{
      "doctype": "Item Price",
      "filters": [
        ["item_code", "like", "KTG-BOOST-%"]
      ],
      "fields": [
        "name",
        "item_code",
        "price_list",
        "currency",
        "price_list_rate"
      ],
      "limit_page_length": 100
    }'

  echo ""
  echo "--- RATTACHEMENTS PRODUITS / SOCIETES ---"

  bench --site "$site" execute frappe.get_all \
    --kwargs '{
      "doctype": "Item Default",
      "filters": [
        ["parent", "like", "KTG-BOOST-%"]
      ],
      "fields": [
        "parent",
        "company",
        "default_warehouse"
      ],
      "limit_page_length": 100
    }'

done

echo ""
echo "========================================="
echo " AUDIT TERMINE - AUCUNE MODIFICATION"
echo "========================================="

REMOTE
