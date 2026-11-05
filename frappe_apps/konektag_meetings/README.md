# Konektag Meetings — ERPNext native override

## Purpose

Installed per Frappe site; `Appointment` still uses ERPNext's native booking,
capacity locking, CRM Lead relations, notifications and Event creation.
Only `auto_assign()` is overridden to prevent a Lead's pre-existing
Opportunity owner from being assigned twice at an overlapping time or from
being assigned when outside this site's `agent_list`.

In the Congo, Charcel and Simon share two booking places. France and Lebanon
have one generic agent each.

## Preflight (mandatory)

- Confirm the live deployed Appointment module exposes `auto_assign()`,
  `get_assignee_from_latest_opportunity()`, `get_busy_agents()`,
  `_get_agents_sorted_by_asc_workload()` and `assign_agent()`.
- Check per-site installed apps and any other
  `override_doctype_class["Appointment"]` hook. Do not override an existing
  custom controller without reconciling behavior.
- Verify `Appointment Booking Settings`: agents, holiday calendar, 30-minute
  windows, 90-day advance limit and correct site timezone.
- Verify Frappe/ERPNext app install method in the current k3s release workflow,
  make a database backup and deploy to staging only.

## Tests

Inside the Frappe bench with this app installed in the Python environment:

```bash
/home/frappe/frappe-bench/env/bin/python -m unittest discover -s apps/konektag_meetings/tests -p 'test_*.py'
```

Verify with real ERPNext integration tests in a disposable test site:
1. Existing Opportunity owned by Charcel, both free -> assigns Charcel.
2. Same owner busy, Simon free -> assigns Simon.
3. Existing Opportunity owned by a person not in `agent_list` -> picks an allowed free agent.
4. Both Charcel and Simon busy -> no third overlapping booking; no orphan Event or new assignment.
5. Simultaneous requests -> native capacity lock prevents overbooking.
6. Single-agent France and Lebanon -> assigns generic agent.
7. Validate `_assign`, related `ToDo`, and `calendar_event`, not only HTTP response.

## Installation policy

Source is located in `frappe_apps/konektag_meetings` in this repository.
It is **not** automatically installed by the API release workflow. Rollout
requires packaging the app into the Frappe bench and explicitly installing
it per site through the existing operator-approved Frappe deployment process,
followed by migrate/restart and verification. Do not patch `apps/erpnext`
or put changes directly in a running container.
