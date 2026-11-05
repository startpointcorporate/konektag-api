#!/usr/bin/env python3
"""Audit/initialize Frappe CRM prerequisites for the Konektag public contact form.

Run from the Frappe bench Python environment with an explicit site. Dry-run by
default. This script NEVER creates Leads or sends emails and never logs secrets.
"""
import argparse
import json
import sys

AXES = (
    "AXE_1_INCUBATION", "AXE_2_PARTENARIAT_CONGO", "AXE_3_MARKETPLACE_CONGO",
    "AXE_4_DIASPORA", "AXE_5_EUROPE",
)
# Existing Konektag Lead contract (src/api/routes/public/commercial-request.ts).
REQUIRED_CUSTOM = {
    "custom_axis": ("Select", "\n".join(("", *AXES))),
    "custom_commercial_stage": ("Select", "\nÀ rechercher\nVérifié\nÀ contacter\nContacté\nQualifié"),
    "custom_next_action": ("Small Text", None),
    "custom_next_action_date": ("Date", None),
    "custom_activity_summary": ("Text Editor", None),
}
REQUIRED_NATIVE = ("lead_name", "company_name", "email_id", "mobile_no", "lead_owner")


def inspect(frappe, owner, axis):
    issues, create, checks = [], [], {}
    if not frappe.db.exists("DocType", "Lead"):
        raise RuntimeError("Frappe Lead DocType is missing")
    meta = frappe.get_meta("Lead")
    for name in REQUIRED_NATIVE:
        if not meta.has_field(name):
            issues.append("Lead native field missing: " + name)
    for name, (kind, options) in REQUIRED_CUSTOM.items():
        field = meta.get_field(name)
        if field is None:
            create.append(name)
            continue
        if field.fieldtype != kind:
            issues.append("Incompatible Lead field type: " + name)
            continue
        if name == "custom_axis" and axis not in (field.options or "").split("\n"):
            issues.append("Routing axis not allowed by Lead.custom_axis: " + axis)
        if name == "custom_commercial_stage" and "À rechercher" not in (field.options or "").split("\n"):
            issues.append("Missing initial stage À rechercher in Lead.custom_commercial_stage")
    checks["lead_fields_missing"] = create
    if not owner:
        issues.append("Required owner missing: pass --owner (same as KONEKTAG_MEETING_LEAD_OWNER)")
    elif not frappe.db.exists("User", {"name": owner, "enabled": 1}):
        issues.append("Lead owner does not exist or is disabled")
    if not axis or axis not in AXES:
        issues.append("Unknown commercial axis: pass --axis with an existing Konektag axis code")
    account = frappe.get_all("Email Account",
        filters={"enable_outgoing": 1, "default_outgoing": 1},
        fields=["name", "email_id"], limit_page_length=3)
    checks["outgoing_email_account_count"] = len(account)
    if len(account) != 1:
        issues.append("Exactly one enabled/default outgoing Frappe Email Account is required; configure SMTP/Resend separately")
    checks["owner_configured"] = bool(owner)
    checks["axis_configured"] = bool(axis)
    checks["source"] = "Formulaire Konektag (Lead acquisition, no marketing consent presumed)"
    checks["api_dependencies"] = [
        "KONEKTAG_MEETING_LEAD_OWNER", "KONEKTAG_MEETING_DEFAULT_AXIS",
        "ERPNEXT_URL", "FRAPPE_API_KEY", "FRAPPE_API_SECRET", "REDIS_URL", "RESEND_API_KEY",
    ]
    return issues, create, checks


def initialize(frappe, missing):
    # Only additive, documented Lead Custom Fields; no stages, assignments,
    # workflows or existing records are overwritten.
    for name in missing:
        kind, options = REQUIRED_CUSTOM[name]
        if frappe.db.exists("Custom Field", "Lead-" + name):
            raise RuntimeError("Conflicting custom field metadata: Lead-" + name)
        doc = {"doctype": "Custom Field", "dt": "Lead", "fieldname": name,
               "label": name.removeprefix("custom_").replace("_", " ").title(),
               "fieldtype": kind, "insert_after": "lead_owner"}
        if options is not None:
            doc["options"] = options
        frappe.get_doc(doc).insert()
    frappe.clear_cache(doctype="Lead")


def run(frappe, args):
    issues, missing, checks = inspect(frappe, args.owner, args.axis)
    if issues:
        return {"ok": False, "mode": "audit" if not args.apply else "apply",
                "issues": issues, "checks": checks, "changes": []}
    if args.apply and missing:
        initialize(frappe, missing)
        frappe.db.commit()
        issues, missing_after, checks = inspect(frappe, args.owner, args.axis)
        return {"ok": not issues and not missing_after, "mode": "apply",
                "issues": issues, "checks": checks, "changes": missing}
    return {"ok": not missing, "mode": "audit" if not args.apply else "apply",
            "issues": ["Custom fields missing; re-run with --apply"] if missing else [],
            "checks": checks, "changes": []}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True, help="Explicit Frappe bench site")
    parser.add_argument("--owner", required=True, help="Enabled CRM User (not guessed)")
    parser.add_argument("--axis", required=True, choices=AXES)
    parser.add_argument("--apply", action="store_true", help="Create missing fields; audit is the default")
    args = parser.parse_args(argv)
    import frappe
    frappe.init(site=args.site)
    frappe.connect()
    try:
        result = run(frappe, args)
        if not result["ok"]:
            frappe.db.rollback()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 2
    except Exception as exc:
        frappe.db.rollback()
        print(json.dumps({"ok": False, "error": type(exc).__name__,
                          "reason": "Initialization failed; no change committed"}))
        return 2
    finally:
        frappe.destroy()


if __name__ == "__main__":
    sys.exit(main())
