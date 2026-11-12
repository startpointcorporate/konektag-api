# pawaPay sandbox: financial isolation

`PAWAPAY_ALLOW_SANDBOX` defaults to disabled. Only the exact value `true` permits an
isolated test process to attempt sandbox financial operations. Never set it on the
shared production API or its workers. No Deployment is changed by this PR.

While onboarding is pending, `config/pawapay-sandbox.env.example` explicitly sets
the flag to true for an isolated test instance. `config/pawapay-live.env.example`
documents the future live PSP settings. Both are examples, not deployed resources.
The PSP API URLs remain environment variables, as do API/ERPNext/Web URLs; no
source change is needed to switch to the official live endpoint after onboarding.
Keep the logical key consistent with its environment and freeze existing attempts.
`PAWAPAY_CHECK_CALLBACK_URL` overrides the recipe's expected deposit callback URL;
otherwise it is derived from `API_PUBLIC_URL` (default: the existing shared API).

`api_payment_orders.environment=live` means that the order uses real business
settlement, accounting and Points K acquisition. It is NOT the PSP environment.
The server-selected `providerConfigurationKey` chooses the PSP account and is
frozen on the order and attempt. A SANDBOX suffix must match the sandbox HTTPS
origin; a LIVE suffix must match the live HTTPS origin. Legacy URL-based
configuration is also checked by the financial sandbox policy.

## Runtime checks

Sandbox finance requires ALL of the following, independently in every process:

- `PAWAPAY_ALLOW_SANDBOX=true`.
- `NODE_ENV=test`, never production or development.
- `DATABASE_URL` names exactly `konektag_test`, on a loopback or explicitly named
  test/sandbox host. The shared business database is refused.
- `API_PUBLIC_URL` points to a loopback or explicitly named test/sandbox host.
- `PUBLIC_SITE_URL`, if set, also points to a test host.
- At least one ERPNext test URL is configured. Every configured FRAPPE/ERPNEXT URL
  and every URL in `LINK_PAY_FRAPPE_SITES` must point to test hosts.

Test hosts are loopback, `.test`, `.localhost`, or a DNS label explicitly containing
`test` or `sandbox` separated by dots/hyphens. These naming checks fail closed on
ordinary production endpoints. They are sanity checks, not proof of infrastructure
isolation: an operator must verify the actual resources before enabling the flag.
The shared origin `https://api.konektag.eu` fails the checks even with the flag true.

Example for local disposable tests (no real credentials):

```sh
PAWAPAY_ALLOW_SANDBOX=true
NODE_ENV=test
DATABASE_URL=postgres://localhost:5432/konektag_test
API_PUBLIC_URL=http://api.test
PUBLIC_SITE_URL=http://web.test
ERPNEXT_URL=http://frappe.test
```

## Required isolation verification before enabling finance

Verify and record the identities of the test PostgreSQL instance/database and its
dedicated credentials, disposable ERPNext sites and their dedicated credentials,
the workers' database/queues, and the callback deployment/host. None may use shared
business storage, credentials or queues. Stop workers during local mocked tests,
or run dedicated workers with the same sandbox policy and isolated database.

In the pawaPay sandbox account, each deposit callback URL must target the isolated
test API, match its `API_PUBLIC_URL`, and remain signature-protected. A portal URL
pointing at the shared API is not a valid financial test setup. Do not change the
portal, register signing keys, enable the flag, or deploy processes implicitly.

## Enforced paths and errors

The policy runs before direct deposit/Payment Page initiation and attempts, generic
Mobile Money confirmation, provider-event consumption, reconciliation failure
recovery, recharge outbox emission, and final settlement (including manual retries
on an order configured for pawaPay). Workers use the same guard. API initiation
and webhook routes report `503 PAWAPAY_SANDBOX_DISABLED` when the policy refuses.

Read-only configuration, public keys, prediction, status lookups and cryptographic
verification remain usable with the flag absent. The contract recipe intentionally
does not enable it and never initiates a payment. Live PSP behavior is unchanged.

The CI PostgreSQL job uses a disposable database and local provider/ERPNext/valuation
doubles. Its isolated fixtures explicitly opt in; tests also disable the flag to
prove that an order marked live cannot bypass the guard. No real provider payment
or shared business write is part of this suite.
