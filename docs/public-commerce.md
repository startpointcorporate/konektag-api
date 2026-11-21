# Public Quotation and Booking

These routes are a server-side façade over native ERPNext Selling and the exact
`konektag-abm` v1 methods. A browser selects an allowlisted site or country; it
never supplies a Frappe URL or credential.

Publication is opt-in through `PUBLIC_COMMERCE_SITES`, for example
`{"abm-demo":{"quotation":true,"booking":true},"rocher-des-ages":{"quotation":true}}`.
The site registry must independently publish `quotation:write`, `booking:read`
and/or `booking:write`. `PUBLIC_COMMERCE_TOKEN_SECRET` must contain at least 32
characters and signs the short-lived visitor capabilities returned at creation.

Quotation creation accepts Item codes, quantities, currency and an ERPNext Price
List. It deliberately accepts no rate, subtotal, tax or total. ERPNext creates a
draft and owns price-list selection, native tax templates and totals; the API
only returns allowlisted totals from that document. A Quotation is distinct from
CRM `Appointment`, which is not a resource reservation.

Booking calls only `konektag_abm.api.availability`, `create_booking`, `transition`
and `reschedule`. `Idempotency-Key` is mandatory for creation. Availability is
aggregate. Reschedule/cancel require the signed capability bound to the site and
booking. If ABM is not installed (notably RDA until validated), the façade returns
`503 {"error":"FEATURE_UNAVAILABLE"}` instead of simulating a reservation.
