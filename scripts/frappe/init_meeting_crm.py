#!/usr/bin/env python3
"""Audit and safely initialize Frappe prerequisites for Konektag meeting requests.

Runs inside a Frappe bench with --site. Audit is read-only. --apply only
enables scheduling and installs explicit operator-provided availability
after all validation; never fabricates agents, holidays or free slots.
Does not create appointments/leads or send emails.
"""
import argparse
import json
import sys

REQUIRED_LEAD_FIELDS = {
    "custom_axis": "Select",
    "custom_commercial_stage": "Select",
    "custom_next_action": "Small Text",
    "custom_next_action_date": "Date",
    "custom_activity_summary": "Text Editor",
}
APPOINTMENT_FIELDS = (
    "scheduled_time", "status", "customer_name", "customer_phone_number",
    "customer_email", "customer_details", "appointment_with", "party",
)
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def read_checks(frappe, owner, axis, agent, holiday_list):
    errors, checks = [], {}
    for dt in ("Lead", "Appointment", "Event", "Holiday List", "Appointment Booking Settings"):
        if not frappe.db.exists("DocType", dt):
            errors.append("Missing DocType: " + dt)
    if errors:
        return errors, checks, None
    lead = frappe.get_meta("Lead")
    for name, kind in REQUIRED_LEAD_FIELDS.items():
        field = lead.get_field(name)
        if field is None or field.fieldtype != kind:
            errors.append("Missing/incompatible Lead field: " + name)
    field = lead.get_field("custom_commercial_stage")
    if field and "À rechercher" not in (field.options or "").split("\n"):
        errors.append("Lead stage À rechercher is not configured")
    axis_field = lead.get_field("custom_axis")
    if axis_field and axis not in (axis_field.options or "").split("\n"):
        errors.append("Lead commercial axis is not configured: " + axis)
    appointment = frappe.get_meta("Appointment")
    for name in APPOINTMENT_FIELDS:
        if not appointment.has_field(name):
            errors.append("Appointment field missing: " + name)
    for name in ("starts_on", "ends_on", "status"):
        if not frappe.get_meta("Event").has_field(name):
            errors.append("Event calendar field missing: " + name)
    if not owner or not frappe.db.exists("User", {"name": owner, "enabled": 1}):
        errors.append("Meeting lead owner must be an enabled Frappe User")
    if not agent or not frappe.db.exists("User", {"name": agent, "enabled": 1}):
        errors.append("Booking agent must be an enabled Frappe User")
    if not holiday_list or not frappe.db.exists("Holiday List", holiday_list):
        errors.append("Holiday List must already exist; no calendar is fabricated")
    settings = frappe.get_doc("Appointment Booking Settings")
    checks["booking_enabled"] = int(settings.enable_scheduling or 0) == 1
    checks["duration_minutes"] = int(settings.appointment_duration or 0)
    checks["agents_configured"] = int(settings.number_of_agents or 0)
    checks["configured_agent_count"] = len(settings.agent_list or [])
    checks["advance_booking_days"] = int(settings.advance_booking_days or 0)
    checks["holiday_list_configured"] = bool(settings.holiday_list)
    checks["weekly_windows"] = len(settings.availability_of_slots or [])
    checks["outgoing_email_configured"] = bool(frappe.get_all(
        "Email Account", filters={"enable_outgoing": 1, "default_outgoing": 1}, limit_page_length=1))
    if not checks["outgoing_email_configured"]:
        errors.append("No enabled default outgoing Frappe email account (verify Resend separately)")
    if settings.holiday_list and settings.holiday_list != holiday_list:
        errors.append("Existing holiday calendar differs from requested one; refuse overwrite")
    if settings.agent_list:
        selected = [str(row.user) for row in settings.agent_list]
        if selected != [agent]:
            errors.append("Existing agent roster differs from requested one; refuse overwrite")
    if settings.availability_of_slots:
        checks["existing_weekdays"] = sorted(set(str(w.day_of_week) for w in settings.availability_of_slots))
    return errors, checks, settings


def parse_windows(value):
    result = []
    for row in value:
        parts = row.split("=")
        if len(parts) != 2 or parts[0] not in WEEKDAYS:
            raise ValueError("Window must be Day=HH:MM-HH:MM with an English weekday")
        times = parts[1].split("-")
        if len(times) != 2:
            raise ValueError("Window must contain start and end")
        def minutes(s):
            import re
            if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", s):
                raise ValueError("Invalid HH:MM window")
            return int(s[:2]) * 60 + int(s[3:])
        begin, end = minutes(times[0]), minutes(times[1])
        if begin >= end or begin % 30 or end % 30 or end - begin < 30:
            raise ValueError("Windows must be positive, aligned to 30 minutes")
        result.append((parts[0], times[0] + ":00", times[1] + ":00"))
    if not result:
        raise ValueError("At least one explicit weekly window required")
    return result


def run(frappe, args):
    windows = parse_windows(args.window)
    errors, checks, settings = read_checks(frappe, args.owner, args.axis, args.agent, args.holiday_list)
    if errors:
        return {"ok": False, "mode": "apply" if args.apply else "audit", "issues": errors, "checks": checks, "changes": []}
    requested = [(a, b, c) for a, b, c in windows]
    actual = [(str(w.day_of_week), str(w.from_time), str(w.to_time)) for w in settings.availability_of_slots or []]
    # ERPNext may serialize times as HH:MM:SS; compare normalized text only.
    normalized = [(a, b[:8], c[:8]) for a, b, c in actual]
    if normalized and normalized != requested:
        return {"ok": False, "mode": "apply" if args.apply else "audit",
                "issues": ["Existing availability differs from requested configuration; manual reconciliation required"],
                "checks": checks, "changes": []}
    if settings.appointment_duration not in (None, 0, 30) and int(settings.appointment_duration) != 30:
        return {"ok": False, "mode": "audit", "issues": ["Existing duration is not 30 minutes"], "checks": checks, "changes": []}
    if int(settings.number_of_agents or 0) not in (0, 1):
        return {"ok": False, "mode": "audit", "issues": ["Existing number_of_agents differs from 1"], "checks": checks, "changes": []}
    if int(settings.advance_booking_days or 0) not in (0, args.advance_days):
        return {"ok": False, "mode": "audit", "issues": ["Existing advance_booking_days differs from requested"], "checks": checks, "changes": []}
    missing = []
    if not int(settings.enable_scheduling or 0): missing.append("enable_scheduling")
    if int(settings.appointment_duration or 0) != 30: missing.append("appointment_duration")
    if int(settings.number_of_agents or 0) != 1: missing.append("number_of_agents")
    if int(settings.advance_booking_days or 0) != args.advance_days: missing.append("advance_booking_days")
    if not settings.holiday_list: missing.append("holiday_list")
    if not settings.agent_list: missing.append("agent_list")
    if not settings.availability_of_slots: missing.append("availability_of_slots")
    if not args.apply:
        return {"ok": not missing, "mode": "audit", "checks": checks, "missing": missing,
                "issues": ["Use --apply only after approving the proposed settings"] if missing else [], "changes": []}
    if missing:
        settings.enable_scheduling = 1
        settings.appointment_duration = 30
        settings.number_of_agents = 1
        settings.advance_booking_days = args.advance_days
        settings.holiday_list = args.holiday_list
        if not settings.agent_list: settings.append("agent_list", {"user": args.agent})
        if not settings.availability_of_slots:
            for day, start, end in requested:
                settings.append("availability_of_slots", {
                    "day_of_week": day, "from_time": start, "to_time": end})
        settings.save()
        frappe.db.commit()
    errors, after, _ = read_checks(frappe, args.owner, args.axis, args.agent, args.holiday_list)
    if errors: raise RuntimeError("Post-initialization validation failed")
    return {"ok": True, "mode": "apply", "checks": after, "changes": missing}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True)
    parser.add_argument("--owner", required=True, help="KONEKTAG_MEETING_LEAD_OWNER")
    parser.add_argument("--axis", required=True, help="KONEKTAG_MEETING_DEFAULT_AXIS")
    parser.add_argument("--agent", required=True, help="Existing Frappe meeting agent")
    parser.add_argument("--holiday-list", required=True, help="Existing Frappe Holiday List name")
    parser.add_argument("--advance-days", type=int, default=90)
    parser.add_argument("--window", action="append", required=True,
                        help="Repeatable Day=HH:MM-HH:MM e.g. Monday=09:00-12:00")
    parser.add_argument("--apply", action="store_true", help="Write missing scheduling settings")
    args = parser.parse_args(argv)
    if not 1 <= args.advance_days <= 180:
        parser.error("--advance-days must be between 1 and 180")
    import frappe
    frappe.init(site=args.site)
    frappe.connect()
    try:
        result = run(frappe, args)
        if not result["ok"]: frappe.db.rollback()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 2
    except Exception as exc:
        frappe.db.rollback()
        print(json.dumps({"ok": False, "error": type(exc).__name__,
                          "reason": "Calendar configuration failed; inspect Frappe before retry"}))
        return 2
    finally:
        frappe.destroy()


if __name__ == "__main__":
    sys.exit(main())
