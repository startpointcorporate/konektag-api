"""Small extension of ERPNext native Appointment assignment.

Preserves native capacity locks, slot validation, calendar events, Lead links
and assignment notifications. Never assigns an unauthorized or busy agent.
"""
import frappe
from frappe.utils import getdate
from erpnext.crm.doctype.appointment.appointment import (
    Appointment as NativeAppointment,
    _get_agents_sorted_by_asc_workload,
    get_busy_agents,
    get_booking_settings,
)


def choose_agent(preferred, configured, busy, ordered_agents):
    """Retain existing opportunity ownership only if configured and free."""
    allowed = set(configured)
    blocked = set(busy)
    if preferred in allowed and preferred not in blocked:
        return preferred
    return next((a for a in ordered_agents if a in allowed and a not in blocked), None)


class KonektagAppointment(NativeAppointment):
    def auto_assign(self):
        if self._assign:
            return
        configured = [row.user for row in get_booking_settings().agent_list]
        if not configured:
            frappe.throw("No appointment agents configured")
        busy = get_busy_agents(self.scheduled_time)
        preferred = self.get_assignee_from_latest_opportunity()
        ordered = _get_agents_sorted_by_asc_workload(getdate(self.scheduled_time))
        agent = choose_agent(preferred, configured, busy, ordered)
        if not agent:
            frappe.throw("No free appointment agent at requested time")
        self.assign_agent(agent)
