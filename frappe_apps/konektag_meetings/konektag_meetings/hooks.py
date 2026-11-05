app_name = "konektag_meetings"
app_title = "Konektag Meetings"
app_publisher = "Konektag"
app_description = "Safeguard native ERPNext appointment assignment"
app_email = "info-konektag@konektag.eu"
app_license = "MIT"

# Frappe supports one override_doctype_class per DocType. Verify that no
# existing installed app overrides Appointment before enabling this hook.
override_doctype_class = {
    "Appointment": "konektag_meetings.appointment.KonektagAppointment",
}
