#!/usr/bin/env python3
"""Apply the specific upstream Appointment busy-agent fix to ERPNext v16.53.0.

Upstream: frappe/erpnext commit b423b4d01151462c172c45b14dde94b9db430e33.
This script FAILS CLOSED if the base file differs; never modify a running pod.
"""
from pathlib import Path
import sys

path=Path(sys.argv[1]) if len(sys.argv)>1 else Path("/home/frappe/frappe-bench/apps/erpnext/erpnext/crm/doctype/appointment/appointment.py")
s=path.read_text()
def replace(old,new):
    global s
    if s.count(old)!=1:
        raise SystemExit("REFUSED: upstream patch anchor missing or changed; verify installed ERPNext sources.")
    s=s.replace(old,new,1)

replace(
    "from frappe.desk.form.assign_to import _add as add_assignment",
    "from frappe.desk.form.assign_to import _add as add_assignment\nfrom frappe.desk.form.assign_to import clear as clear_assignments"
)
replace(
    "\t\tself.sync_calendar_event()\n\n\tdef sync_calendar_event(self):",
    """\t\tself.sync_calendar_event()
\t\tself.reassign_if_agent_busy()

\tdef reassign_if_agent_busy(self):
\t\t# ERPNext upstream b423b4d: avoid keeping a busy agent on rescheduling.
\t\tif not (self._assign and self.has_value_changed("scheduled_time")):
\t\t\treturn
\t\tbusy_agents = get_busy_agents(self.scheduled_time, exclude_appointment=self.name)
\t\tcurrent_agents = frappe.parse_json(self._assign)
\t\tif not busy_agents.intersection(current_agents):
\t\t\treturn
\t\tif agent := self.get_free_agent(busy_agents):
\t\t\tclear_assignments(self.doctype, self.name, ignore_permissions=True)
\t\t\tself.assign_agent(agent)

\tdef sync_calendar_event(self):"""
)
replace(
    """\t\tif existing_assignee := self.get_assignee_from_latest_opportunity():
\t\t\t# assign to whoever handles the party's latest opportunity
\t\t\tself.assign_agent(existing_assignee)
\t\t\treturn

\t\tbusy_agents = get_busy_agents(self.scheduled_time)
\t\tfor agent in _get_agents_sorted_by_asc_workload(getdate(self.scheduled_time)):
\t\t\tif agent not in busy_agents:
\t\t\t\tself.assign_agent(agent)
\t\t\t\tbreak
""",
    """\t\tif agent := self.get_free_agent(get_busy_agents(self.scheduled_time, exclude_appointment=self.name)):
\t\t\tself.assign_agent(agent)

\tdef get_free_agent(self, busy_agents: set[str]) -> str | None:
\t\t# Upstream: priority for the existing Opportunity owner only when free.
\t\texisting_assignee = self.get_assignee_from_latest_opportunity()
\t\tif existing_assignee and existing_assignee not in busy_agents:
\t\t\treturn existing_assignee
\t\tagents = _get_agents_sorted_by_asc_workload(getdate(self.scheduled_time))
\t\treturn next((agent for agent in agents if agent not in busy_agents), None)
"""
)
replace(
    "def get_busy_agents(scheduled_time):",
    "def get_busy_agents(scheduled_time, exclude_appointment: str | None = None) -> set[str]:"
)
replace(
    """\t\t\t["status", "!=", "Closed"],
\t\t],
\t\tpluck="_assign",
\t)
\treturn {assignee for assign in assigns for assignee in frappe.parse_json(assign or "[]")}
""",
    """\t\t\t["status", "!=", "Closed"],
\t\t\t["name", "!=", exclude_appointment or ""],
\t\t],
\t\tpluck="_assign",
\t)
\treturn {assignee for assign in assigns for assignee in frappe.parse_json(assign or "[]")}
"""
)
compile(s,str(path),"exec")
path.write_text(s)
print("OFFICIAL_APPOINTMENT_AGENT_PATCH_APPLIED")
