# ERPNext official appointment fix — Konektag three-site cluster

**This is a targeted official upstream backport, not a general ERPNext release upgrade.**
The published ERPNext v16.53.0 source still has the busy-Opportunity-owner
bug; upstream fixed it in commit
[b423b4d01151462c172c45b14dde94b9db430e33](https://github.com/frappe/erpnext/commit/b423b4d01151462c172c45b14dde94b9db430e33).
The corrected behavior was merged into version-16, but release v16.53.0
does not contain it.

The original bespoke `konektag_meetings` app has been removed.
The image is built `FROM docker.io/konektag/erpnext:v16.53.0-custom`,
and changes only the native `appointment.py`, leaving these **present**:
- frappe, erpnext and crm
- hospitality_core
- lumen_restaurants

The patcher requires exact source anchors and fails closed if they differ.

## Build (no deployment)

On the original custom-image build node, with that exact image available
to the chosen container build engine (Docker or nerdctl):

```bash
bash scripts/erpnext/build-appointment-fix.sh
# optionally: CONTAINER_BUILD_ENGINE=nerdctl bash scripts/erpnext/build-appointment-fix.sh
```

Result: `docker.io/konektag/erpnext:v16.53.0-custom-appointment-fix-20261105`.

**Do not** assume `pullPolicy: Never` downloads it. Import the resulting
image to the **konektag-clients K3s containerd** runtime and verify
the image digest there before any Helm update.

## Mandatory deployment prerequisites

1. Locate original custom image build source and exact Helm chart repository
   for release `konektag` chart `erpnext-8.0.90` revision 8.
2. Identify NFS volumes and verify backup/restore of MariaDB databases for
   all three sites, `sites` data, and complete Helm release values.
3. Run the official ERPNext appointment regression tests in a disposable Frappe
   site matching current runtime. Include two simultaneous Congo bookings,
   existing Opportunity owner busy, moving appointments, booked-slot capacity,
   and one-agent France/Lebanon.
4. Verify a complete image on the K3s node with all custom apps and exact
   Frappe/ERPNext/CRM versions.
5. During an approved maintenance window, `helm upgrade` the SAME release,
   updating **only** `image.tag`, retaining the complete previous values,
   PVCs, jobs and custom configuration. No default chart values.
6. Restart/verify pods, then test all three sites and API end-to-end. Roll
   back the Helm revision if checks fail; DB backups are separate.

Existing release: namespace `konektag-common`, release `konektag`,
chart `erpnext-8.0.90`, revision 8, node `konektag-clients`,
image pull policy `Never`, image
`docker.io/konektag/erpnext:v16.53.0-custom`.

**This repository does not yet contain the verified original image builder
or Helm chart source. No automated production deployment is provided until
those are confirmed.** An unverified one-shot Helm install could remove
Hospitality/Lumen access or interrupt all three sites.
