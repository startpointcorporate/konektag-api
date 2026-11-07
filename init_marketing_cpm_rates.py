#!/usr/bin/env python3
"""Install Marketing CPM Rate and seed 7 monthly CPM ranges on 3 independent ERPNext sites.

Read-only by default. Run --apply only after inspecting the audit and approving
November 2026 values. Does not update ERPNext Item Price or Konektag PostgreSQL.
"""
import argparse
import hashlib
import json
import re
import shlex
import subprocess
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

DOCT = "Marketing CPM Rate"
SITE_CONFIG = {
    "Konektag Congo": ("congo.erp.konektag.eu", "konektag congo", "CG", "XAF"),
    "Konektag Europe": ("europe.erp.konektag.eu", "konektag europe", "FR", "EUR"),
    "Konektag Lebanon": ("liban.erp.konektag.eu", "konektag lebanon", "LB", "USD"),
}
NETWORKS = ("facebook", "instagram", "tiktok")
FIELDS = [
    {"fieldname": "rate_key", "label": "Clé tarif", "fieldtype": "Data", "reqd": 1, "unique": 1, "read_only": 1},
    {"fieldname": "company", "label": "Société", "fieldtype": "Link", "options": "Company", "reqd": 1},
    {"fieldname": "item_code", "label": "Produit", "fieldtype": "Link", "options": "Item", "reqd": 1},
    {"fieldname": "target_country", "label": "Pays cible (ISO2)", "fieldtype": "Data", "reqd": 1},
    {"fieldname": "network", "label": "Réseau", "fieldtype": "Select", "options": "\n".join(NETWORKS), "reqd": 1},
    {"fieldname": "currency", "label": "Devise", "fieldtype": "Link", "options": "Currency", "reqd": 1},
    {"fieldname": "cpm_low", "label": "CPM minimum", "fieldtype": "Currency", "options": "currency", "reqd": 1},
    {"fieldname": "cpm_high", "label": "CPM maximum", "fieldtype": "Currency", "options": "currency", "reqd": 1},
    {"fieldname": "reference_month", "label": "Mois de référence", "fieldtype": "Date", "reqd": 1},
    {"fieldname": "source_sha256", "label": "Empreinte JSON", "fieldtype": "Data", "read_only": 1},
    {"fieldname": "is_active", "label": "Actif", "fieldtype": "Check", "default": "1"},
]


def remote(args, site, method, kwargs):
    # JSON passed as ONE shell-escaped argument, not interpolated inside a shell script.
    command = ["sudo", "k3s", "kubectl", "-n", args.namespace, "exec", args.pod,
               "--", "bench", "--site", site, "execute", method,
               "--kwargs", json.dumps(kwargs, ensure_ascii=False, separators=(",", ":"))]
    proc = subprocess.run(["ssh", args.host, shlex.join(command)], capture_output=True, text=True)
    if proc.returncode:
        raise RuntimeError(f"{site}/{method}: {proc.stderr.strip() or proc.stdout.strip()}")
    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        # On this Frappe bench, frappe.get_all prints no output when the
        # result is an empty list. This is a valid result for an absent
        # custom DocType or a not-yet-created monthly rate.
        # Never treat empty output from a mutating method as success.
        if method == "frappe.get_all":
            return []
        raise RuntimeError(f"Réponse vide inattendue : {site}/{method}")
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError:
        # bench execute frappe.db.exists prints None or a bare string.
        if lines[-1] == "None":
            return None
        return lines[-1]


def get_all(args, site, dt, filters, fields):
    result = remote(args, site, "frappe.get_all", {
        "doctype": dt, "filters": filters, "fields": fields, "limit_page_length": 100
    })
    if not isinstance(result, list):
        raise RuntimeError(f"Réponse inattendue pour {site}/{dt}: {str(result)[:200]}")
    return result


def parse_input(path):
    raw = path.read_bytes()
    data = json.loads(raw)
    if not isinstance(data, dict) or set(data) != {"month", "rates"}:
        raise ValueError("Le JSON doit contenir uniquement month et rates")
    month = data["month"]
    if not isinstance(month, str) or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise ValueError("Mois incorrect")
    if not isinstance(data["rates"], list) or len(data["rates"]) != 7:
        raise ValueError("7 lignes CPM attendues pour le périmètre initial")
    result = []
    seen = set()
    for row in data["rates"]:
        if not isinstance(row, dict) or set(row) != {
            "billingCompany", "targetCountry", "countryName", "network", "currency", "cpmLow", "cpmHigh"
        }:
            raise ValueError("Champs CPM inattendus")
        company = row["billingCompany"]
        if company not in SITE_CONFIG:
            raise ValueError(f"Société inconnue : {company}")
        site, frappe_company, country, currency = SITE_CONFIG[company]
        network = row["network"]
        if row["targetCountry"] != country or row["currency"] != currency or network not in NETWORKS:
            raise ValueError(f"Pays, réseau ou devise incorrects : {row}")
        if type(row["cpmLow"]) not in (int, float) or type(row["cpmHigh"]) not in (int, float):
            raise ValueError("CPM numérique attendu")
        try:
            low, high = Decimal(str(row["cpmLow"])), Decimal(str(row["cpmHigh"]))
        except InvalidOperation as exc:
            raise ValueError("CPM invalide") from exc
        if not low.is_finite() or not high.is_finite() or low <= 0 or high < low or high > 10**9:
            raise ValueError("Fourchette CPM invalide")
        if currency == "XAF" and (low != low.to_integral_value() or high != high.to_integral_value()):
            raise ValueError("XAF sans centimes attendu")
        item_code = f"KTG-BOOST-{network.upper()}-{country}"
        key = f"{month}-{country}-{network}"
        if key in seen:
            raise ValueError(f"Doublon : {key}")
        seen.add(key)
        result.append((site, frappe_company, country, currency, network, item_code, key, low, high))
    return month, hashlib.sha256(raw).hexdigest(), result


def audit(args, rows):
    sites = sorted({r[0] for r in rows})
    doctype_present = {}
    print("=== PRÉCONTRÔLES (AUCUNE ÉCRITURE) ===", flush=True)
    for site in sites:
        docs = get_all(args, site, "DocType", {"name": DOCT}, ["name", "custom", "autoname"])
        if len(docs) > 1:
            raise RuntimeError(f"DocType ambigu : {site}")
        doctype_present[site] = bool(docs)
        if docs:
            if not docs[0].get("custom") or docs[0].get("autoname") != "field:rate_key":
                raise RuntimeError(f"DocType existant incompatible sur {site}")
            actual = get_all(args, site, "DocField", {"parent": DOCT}, ["fieldname", "fieldtype", "options"])
            actual_fields = {d["fieldname"]: d for d in actual}
            for field in FIELDS:
                found = actual_fields.get(field["fieldname"])
                if not found or found["fieldtype"] != field["fieldtype"] or (field.get("options") and found.get("options") != field["options"]):
                    raise RuntimeError(f"Champ DocType incompatible : {site}/{field['fieldname']}")
        print(f"{site}: DocType {'EXISTE' if docs else 'A CRÉER'}", flush=True)

    to_create = []
    for site, company, country, currency, network, item, key, low, high in rows:
        assert_one = lambda dt, filt, fields: get_all(args, site, dt, filt, fields)
        companies = assert_one("Company", {"name": company}, ["name", "default_currency"])
        items = assert_one("Item", {"item_code": item}, ["name", "item_code", "is_stock_item", "disabled", "stock_uom"])
        defaults = assert_one("Item Default", {"parent": item, "company": company}, ["parent", "company"])
        currencies = assert_one("Currency", {"name": currency}, ["name"])
        if len(companies) != 1 or companies[0]["default_currency"] != currency:
            raise RuntimeError(f"Company/devise invalide : {site}/{company}")
        if len(items) != 1 or items[0]["disabled"] or items[0]["is_stock_item"] or items[0]["stock_uom"] != "Nos":
            raise RuntimeError(f"Article manquant/invalide : {site}/{item}")
        if len(defaults) != 1 or len(currencies) != 1:
            raise RuntimeError(f"Item Default ou Currency manquant : {site}/{item}")
        if doctype_present[site]:
            found = assert_one(DOCT, {"rate_key": key}, ["name", "rate_key", "company", "item_code", "currency", "cpm_low", "cpm_high", "reference_month", "source_sha256"])
            if len(found) > 1:
                raise RuntimeError(f"Doublon en base : {site}/{key}")
            if found:
                existing = found[0]
                expected = {"company": company, "item_code": item, "currency": currency, "reference_month": key[:7] + "-01"}
                if any(str(existing.get(k)) != str(v) for k, v in expected.items()) or Decimal(str(existing["cpm_low"])) != low or Decimal(str(existing["cpm_high"])) != high:
                    raise RuntimeError(f"CONFLIT : {site}/{key} : ne pas écraser")
                print(f"EXISTE {site}/{key}: {low}-{high} {currency}", flush=True)
                continue
        print(f"À CRÉER {site}/{key}: {low}-{high} {currency}", flush=True)
        to_create.append((site, company, country, currency, network, item, key, low, high))
    return doctype_present, to_create


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("json_file", type=Path)
    parser.add_argument("--host", default="konektag-core")
    parser.add_argument("--namespace", default="konektag-common")
    parser.add_argument("--pod", default="deployment/konektag-erpnext-gunicorn")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-benchmarks-reviewed", action="store_true")
    args = parser.parse_args()
    if args.apply and not args.confirm_benchmarks_reviewed:
        parser.error("--apply nécessite --confirm-benchmarks-reviewed")
    month, sha, rows = parse_input(args.json_file)
    doctype_present, to_create = audit(args, rows)
    print(f"BILAN : {sum(not v for v in doctype_present.values())} DocType à créer, {len(to_create)} tarifs à créer, mois {month}", flush=True)
    if not args.apply:
        print("DRY-RUN OK. Aucun document créé.", flush=True)
        return

    for site, existing in doctype_present.items():
        if existing:
            continue
        doc = {
            "doctype": "DocType", "name": DOCT, "module": "Custom", "custom": 1,
            "autoname": "field:rate_key", "istable": 0, "track_changes": 1,
            "fields": FIELDS,
            "permissions": [{"role": "System Manager", "read": 1, "write": 1, "create": 1, "delete": 0}]
        }
        created = remote(args, site, "frappe.client.insert", {"doc": doc})
        if not isinstance(created, dict) or created.get("name") != DOCT:
            raise RuntimeError(f"Création DocType non confirmée : {site}")
        print(f"DOC TYPE CRÉÉ : {site}/{DOCT}", flush=True)

    for site, company, country, currency, network, item, key, low, high in to_create:
        document = {
            "doctype": DOCT, "rate_key": key, "company": company,
            "item_code": item, "target_country": country, "network": network,
            "currency": currency, "cpm_low": float(low), "cpm_high": float(high),
            "reference_month": f"{month}-01", "source_sha256": sha, "is_active": 1,
        }
        created = remote(args, site, "frappe.client.insert", {"doc": document})
        if not isinstance(created, dict) or created.get("name") != key:
            raise RuntimeError(f"Création tarif non confirmée : {site}/{key}")
        print(f"TARIF CRÉÉ : {site}/{key}", flush=True)
    print("TERMINE : pas de modification Item Price ni PostgreSQL.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERREUR: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
