# Commercial meetings: three legal entities (staging)

The public API requires the explicit legal-entity country **CG**, **FR** or **LB** for both `GET /api/meeting-slots?date=YYYY-MM-DD&country=CG` and `POST /api/meeting-request` (`country` in JSON). No default fallback is permitted.

## Existing ERPNext sites

Supply actual Frappe **site-specific** HTTPS origins and a scoped API token for each legal entity through the existing Kubernetes Secret, never through public environment variables or client JavaScript:

| Country | Origin | Key | Secret | Calendar timezone |
| --- | --- | --- | --- | --- |
| CG | `ERPNEXT_CG_URL` | `ERPNEXT_CG_API_KEY` | `ERPNEXT_CG_API_SECRET` | Africa/Brazzaville |
| FR | `ERPNEXT_FR_URL` | `ERPNEXT_FR_API_KEY` | `ERPNEXT_FR_API_SECRET` | Europe/Paris |
| LB | `ERPNEXT_LB_URL` | `ERPNEXT_LB_API_KEY` | `ERPNEXT_LB_API_SECRET` | Asia/Beirut |

Also configure per-site CRM rules: `KONEKTAG_MEETING_CG_DEFAULT_AXIS`, `KONEKTAG_MEETING_CG_LEAD_OWNER` and equivalent `FR`/`LB` variables. Do not assume all three sites have the same CRM settings.

Each site must have its own `Appointment Booking Settings`: enable scheduling; duration 30 min; one assigned agent; configured advance booking days; real weekly windows; holiday list. No fake slots are generated.

## Deployment gate

1. Verify that each configured origin is the **correct Frappe site**, not a generic multi-site server URL; use unique site hostnames or an approved Frappe routing strategy.
2. Test no cross-site data access, 422 on missing/unsupported country, legitimate no-availability, booking conflicts and lead creation in the selected site.
3. Run `npm run typecheck && npm test && npm run build` for API, plus `npm run check && npm test && npm run build` under `astro-site` for web.
4. Deploy API to staging before web; confirm all three sites through the web BFF. Production is explicitly out of scope.

If a country is not configured, return unavailable rather than silently routing to Congo.
