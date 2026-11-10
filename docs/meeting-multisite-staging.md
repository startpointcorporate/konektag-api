# Commercial meetings: three legal entities (staging)

The visitor's residence country (`country`, ISO 3166-1 alpha-2) is routed server-side to the Konektag entity and its Frappe site: see [frappe-site-routing.md](frappe-site-routing.md). The slots, the Lead and the Appointment of one request always come from that single site.

| Entity | Slug | Site | Calendar timezone |
| --- | --- | --- | --- |
| CG | `konektag-cg` | `CONGO` | Africa/Brazzaville |
| FR | `konektag-fr` | `EUROPE` | Europe/Paris |
| LB | `konektag-lb` | `LIBAN` | Asia/Beirut |

Site credentials are `MARKETPLACE_FRAPPE_<SITE>_URL` / `_API_KEY` / `_API_SECRET`, in Kubernetes Secrets. The former `ERPNEXT_<COUNTRY>_*` variables are no longer read. Keep the per-entity CRM rules `KONEKTAG_MEETING_<COUNTRY>_LEAD_OWNER` (and `_DEFAULT_AXIS` where the site requires it).

Each site must have its own `Appointment Booking Settings`: enable scheduling; duration 30 min; one assigned agent; configured advance booking days; real weekly windows; holiday list. No fake slots are generated.

## Deployment gate

1. Verify that each configured origin is the **correct Frappe site**, not a generic multi-site server URL; use unique site hostnames or an approved Frappe routing strategy.
2. Test no cross-site data access, 422 on missing/unsupported country, legitimate no-availability, booking conflicts and lead creation in the selected site.
3. Run `npm run typecheck && npm test && npm run build` for API, plus `npm run check && npm test && npm run build` under `astro-site` for web.
4. Deploy API to staging before web; confirm all three sites through the web BFF. Production is explicitly out of scope.

A country without rule or site returns an explicit error rather than silently routing to Congo.
