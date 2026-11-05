#!/usr/bin/env python3
"""Idempotent site-scoped ERPNext Appointment/Holiday initializer. Audit is read-only.

Run from /home/frappe/frappe-bench using env/bin/python, with --site and --apply.
Never creates users, leads, appointments, or tentative 2027 lunar holidays.
"""
import argparse
import calendar
import datetime as dt
import json
import os
import sys

SITES = {
    "congo.erp.konektag.eu": {
        "country": "CG", "timezone": "Africa/Brazzaville",
        "agents": ["charcelbalou2010@gmail.com", "simon@konektag.eu"],
        "weekdays": ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday"),
        "hours": ("09:00:00", "17:00:00"),
    },
    "europe.erp.konektag.eu": {
        "country": "FR", "timezone": "Europe/Paris",
        "agents": ["info-konektag@konektag.eu"],
        "weekdays": ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"),
        "hours": ("08:00:00", "16:00:00"),
    },
    "liban.erp.konektag.eu": {
        "country": "LB", "timezone": "Asia/Beirut",
        "agents": ["info-konektag@konektag.eu"],
        "weekdays": ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday"),
        "hours": ("09:00:00", "17:00:00"),
    },
}
START, END = dt.date(2026, 1, 1), dt.date(2027, 12, 31)

def easter_western(year):
    # Meeus/Jones/Butcher Gregorian computus.
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f, g = (b + 8) // 25, (b - (b + 8) // 25 + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return dt.date(year, month, day)

def easter_orthodox(year):
    # Julian Easter converted to Gregorian (13-day delta in 2026-2027).
    a, b, c = year % 4, year % 7, year % 19
    d = (19 * c + 15) % 30
    e = (2 * a + 4 * b - d + 34) % 7
    month = (d + e + 114) // 31
    day = (d + e + 114) % 31 + 1
    return dt.date(year, month, day) + dt.timedelta(days=13)

def holidays(country):
    items = {}
    def add(day, name):
        items.setdefault(day, name)
    for year in (2026, 2027):
        def fixed(month, day, name):
            add(dt.date(year, month, day), name)
        easter = easter_western(year)
        fixed(1, 1, "Jour de l'An")
        fixed(5, 1, "Fête du Travail")
        fixed(12, 25, "Noël")
        if country == "CG":
            add(easter + dt.timedelta(days=1), "Lundi de Pâques")
            add(easter + dt.timedelta(days=39), "Ascension")
            add(easter + dt.timedelta(days=50), "Lundi de Pentecôte")
            for month, day, label in [
                (6, 10, "Fête de la Réconciliation"),
                (8, 15, "Fête nationale"),
                (11, 1, "Toussaint"),
                (11, 28, "Jour de la République"),
            ]:
                fixed(month, day, label)
        elif country == "FR":
            add(easter + dt.timedelta(days=1), "Lundi de Pâques")
            add(easter + dt.timedelta(days=39), "Ascension")
            add(easter + dt.timedelta(days=50), "Lundi de Pentecôte")
            for month, day, label in [
                (5, 8, "Victoire de 1945"), (7, 14, "Fête nationale"),
                (8, 15, "Assomption"), (11, 1, "Toussaint"),
                (11, 11, "Armistice de 1918"),
            ]:
                fixed(month, day, label)
        else:  # Lebanon: confirmed fixed + calculated Christian dates only.
            for month, day, label in [
                (1, 6, "Noël arménien"), (2, 9, "Saint Maron"),
                (3, 25, "Annonciation"), (8, 15, "Assomption"),
                (11, 22, "Indépendance"),
            ]:
                fixed(month, day, label)
            add(easter - dt.timedelta(days=2), "Vendredi saint catholique")
            add(easter + dt.timedelta(days=1), "Lundi de Pâques catholique")
            eastern = easter_orthodox(year)
            add(eastern - dt.timedelta(days=2), "Vendredi saint orthodoxe")
            add(eastern + dt.timedelta(days=1), "Lundi de Pâques orthodoxe")
    if country == "LB":
        # 2026 supplied holiday dates. Religious lunar dates are provisional.
        # 2027 lunar holidays are deliberately NOT invented.
        for iso, name in [
            ("2026-03-20", "Aïd el-Fitr (provisoire)"),
            ("2026-05-27", "Aïd al-Adha (provisoire)"),
            ("2026-06-16", "Nouvel An de l'Hégire (provisoire)"),
            ("2026-06-26", "Achoura (provisoire)"),
            ("2026-08-25", "Mawlid (provisoire)"),
        ]:
            add(dt.date.fromisoformat(iso), name)
    return sorted((day, name) for day, name in items.items())

def normalize_time(value):
    parts = str(value or "").split(":")
    if len(parts) != 3:
        return str(value or "")
    return ":".join(str(int(p)).zfill(2) for p in parts)

def audit(frappe, site, config):
    issues = []
    for name in ("Holiday List", "Appointment Booking Settings", "User"):
        if not frappe.db.exists("DocType", name):
            issues.append("Missing DocType " + name)
    if issues:
        return None, None, issues, []
    timezone = frappe.db.get_single_value("System Settings", "time_zone")
    if str(timezone or "") != config["timezone"]:
        issues.append("Site System Settings timezone mismatch: expected " + config["timezone"] + ", got " + str(timezone))
    for user in config["agents"]:
        if not frappe.db.exists("User", {"name": user, "enabled": 1}):
            issues.append("Agent missing or disabled: " + user)
    label = "Konektag " + config["country"] + " 2026-2027"
    expected = holidays(config["country"])
    existing = frappe.db.exists("Holiday List", label)
    if existing:
        holiday_doc = frappe.get_doc("Holiday List", label)
        found = sorted((dt.date.fromisoformat(str(h.holiday_date)[:10]), str(h.description or ""))
                       for h in holiday_doc.holidays)
        if (str(holiday_doc.from_date)[:10] != START.isoformat() or
                str(holiday_doc.to_date)[:10] != END.isoformat() or found != expected):
            issues.append("Existing holiday list differs; manual reconciliation required: " + label)
    settings = frappe.get_doc("Appointment Booking Settings")
    wanted_windows = [(day, *config["hours"]) for day in config["weekdays"]]
    actual_windows = [(str(x.day_of_week), normalize_time(x.from_time), normalize_time(x.to_time))
                      for x in (settings.availability_of_slots or [])]
    wanted_agents = config["agents"]
    actual_agents = [str(x.user) for x in (settings.agent_list or [])]
    enabled = int(settings.enable_scheduling or 0) == 1
    already_configured = (enabled or bool(actual_agents) or bool(actual_windows) or bool(settings.holiday_list))
    expected_state = (
        int(settings.appointment_duration or 0) == 30 and
        int(settings.number_of_agents or 0) == len(wanted_agents) and
        int(settings.advance_booking_days or 0) == 90 and
        str(settings.holiday_list or "") == label and
        actual_agents == wanted_agents and actual_windows == wanted_windows
    )
    if already_configured and not expected_state:
        issues.append("Appointment settings already modified: refuse to overwrite unrelated configuration")
    if enabled and not expected_state:
        issues.append("Enabled scheduling differs from desired state")
    if config["country"] == "LB":
        issues.append("NOTICE: 2027 Islamic lunar holidays are not confirmed and not imported; review before booking those dates")
    result = {
        "site": site, "country": config["country"], "timezone": config["timezone"],
        "holiday_list": label, "holiday_entries": len(expected),
        "agents": wanted_agents, "working_days": list(config["weekdays"]),
        "hours": list(config["hours"]), "duration_minutes": 30,
        "advance_booking_days": 90, "current_enabled": enabled,
        "matches_target": bool(enabled and expected_state and existing),
    }
    blocking = [x for x in issues if not x.startswith("NOTICE:")]
    return result, (settings, expected, label, wanted_windows), blocking, [x for x in issues if x.startswith("NOTICE:")]

def run(frappe, site, apply):
    config = SITES[site]
    report, data, errors, notices = audit(frappe, site, config)
    if errors:
        return {"ok": False, "mode": "apply" if apply else "audit", "report": report,
                "errors": errors, "notices": notices}
    if not apply:
        return {"ok": True, "mode": "audit", "report": report, "notices": notices, "changes": []}
    settings, dates, label, windows = data
    changes = []
    if not frappe.db.exists("Holiday List", label):
        holidays_doc = frappe.new_doc("Holiday List")
        holidays_doc.holiday_list_name = label
        holidays_doc.from_date, holidays_doc.to_date = START, END
        for day, name in dates:
            holidays_doc.append("holidays", {"holiday_date": day, "description": name})
        holidays_doc.insert(ignore_permissions=True)
        changes.append("created holiday list " + label)
    if not report["matches_target"]:
        settings.appointment_duration = 30
        settings.advance_booking_days = 90
        settings.number_of_agents = len(config["agents"])
        settings.holiday_list = label
        if not settings.agent_list:
            for agent in config["agents"]:
                settings.append("agent_list", {"user": agent})
        if not settings.availability_of_slots:
            for day, start, end in windows:
                settings.append("availability_of_slots", {
                    "day_of_week": day, "from_time": start, "to_time": end
                })
        settings.enable_scheduling = 1
        settings.save(ignore_permissions=True)
        changes.append("configured Appointment Booking Settings")
    frappe.db.commit()
    verified, _, failures, notices = audit(frappe, site, config)
    return {"ok": not failures and verified["matches_target"], "mode": "apply",
            "report": verified, "changes": changes, "errors": failures, "notices": notices}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", choices=sorted(SITES), required=True)
    parser.add_argument("--apply", action="store_true", help="Write configuration after audit; otherwise read-only")
    args = parser.parse_args()
    # Frappe v16 logger resolves ../logs relative to the sites working directory.
    sites_path = "/home/frappe/frappe-bench/sites"
    os.chdir(sites_path)
    import frappe
    frappe.init(site=args.site, sites_path=".")
    frappe.connect()
    try:
        result = run(frappe, args.site, args.apply)
        if not result["ok"]:
            frappe.db.rollback()
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        return 0 if result["ok"] else 2
    except Exception as exc:
        frappe.db.rollback()
        print(json.dumps({"ok": False, "error": type(exc).__name__,
                          "message": str(exc)[:300]}, ensure_ascii=False))
        return 2
    finally:
        frappe.destroy()

if __name__ == "__main__":
    sys.exit(main())
