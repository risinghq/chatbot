# Eligibility

A business that sells on Cálidda credit can check whether a customer qualifies.
Cálidda is Lima's natural-gas distributor and extends credit to its customers.
The customer's DNI goes to two Cálidda sources, which answer whether they
qualify, for how much, and under which program.

The check is optional. A business uses it by entering its own Cálidda login. The
providers and the thresholds are fixed in code and every business shares them.

The assistant runs the check in a conversation
([In a conversation](#in-a-conversation)), and platform operators run it from
[the DNI lookup](#looking-up-a-dni).

## The two providers

| `source`  | Backend                                              | Client                                                                          |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `fnb`     | Cálidda's web API: a login, then a credit-line query | [`fnb-client.ts`](../apps/backend/src/adapters/providers/fnb-client.ts)         |
| `powerbi` | A public Cálidda Power BI report: four queries       | [`powerbi-client.ts`](../apps/backend/src/adapters/providers/powerbi-client.ts) |

FNB answers with a credit line and a name. Power BI answers with a status, a
name, a balance and an NSE (socio-economic stratum).

The credentials are set on the dashboard, not as deploy-time secrets. The
Cálidda login is per tenant — each business sells on its own Cálidda account —
so a tenant admin enters the username and the password on the settings page
(`calidda_username`, `calidda_password`). The username lives in
`tenant_settings`; the password is encrypted in `tenant_secrets` under
`SECRETS_KEY` and is never sent back to the browser
([`domains/settings/calidda.ts`](../apps/backend/src/domains/settings/calidda.ts)).
The Cálidda API host is the same for every business, so `CALIDDA_BASE_URL` stays
a platform variable on the Worker, not a setting. The Power BI report is one
public report for every tenant, so its four ids are platform settings
(`powerbi_resource_key`, `powerbi_report_id`, `powerbi_dataset_id`,
`powerbi_model_id`) that a platform operator enters on `/dashboard/ajustes`. A
tenant with no login, or a platform with no report ids or no base URL, fails
that provider's checks as unavailable, the same as an outage. Saving a login
drops the tenant's cached FNB session and its breaker block, so the next check
authenticates with the new credentials.

Timeouts are 10 s for the FNB login, 15 s for the FNB query and 20 s for each
Power BI query ([`config/timeouts.ts`](../apps/backend/src/config/timeouts.ts)).
Nothing is retried. A tenant's FNB login token is kept in KV for 3500 s, keyed
by tenant, and shared by every isolate
([`fnb-client.ts`](../apps/backend/src/adapters/providers/fnb-client.ts)).

## Which answer wins

[`check-eligibility-handler.ts`](../apps/backend/src/domains/eligibility/handlers/check-eligibility-handler.ts)
queries both providers in parallel for every DNI. Then
[`eligibility-strategy.ts`](../apps/backend/src/domains/eligibility/strategy/eligibility-strategy.ts)
picks one answer:

```text
FNB approves                         -> FNB's answer
FNB refused or failed, Power BI
approves                             -> Power BI's answer
both failed                          -> system outage
otherwise                            -> not eligible
```

An FNB approval wins over a Power BI approval, and a Power BI approval wins over
an FNB refusal. When one provider fails and the other refuses, the customer is
not eligible; that is not an outage. A provider "fails" when it throws, times
out, is switched off, or has its circuit breaker open.

## The result

The handler returns a `CreditCheck` (`@vendeya/types`): `eligible` with the
`source` that approved (`fnb` or `powerbi`), the credit, the name and, from
Power BI, the NSE; `not_eligible`; or `system_outage`. A check that throws
returns an error instead. The result says nothing about the catalog: what the
customer can buy with the credit is the assistant's call.

## In a conversation

The assistant's `check_calidda_credit` tool
([`tools/credit.ts`](../apps/backend/src/domains/assistant/tools/credit.ts))
runs the check for the conversation's business. It is offered only when the
business has a Cálidda login, so a business without one never asks for a DNI.
The model reads `eligible` with the credit line, `not_eligible`, or
`unavailable` for an outage. It never reads the name or the NSE: anyone can type
a stranger's DNI in a chat. A simulated conversation runs the real check.

## Outages

When both providers fail, the backend emits `system_outage_detected`. When one
provider fails and the other answers, it emits `provider_degraded`. Both alert
the dev group.

## The circuit breaker

[`adapters/providers/health.ts`](../apps/backend/src/adapters/providers/health.ts)
blocks a provider for 30 minutes when its error message contains `auth`, `401`
or `403` (or `bloqueado`, for FNB). A blocked provider fails at once without a
request. A block is a KV key that expires when the block ends, so every isolate
sees it. An FNB block is per tenant — a bad password is one business's problem —
while the Power BI block is platform-wide. KV takes up to a minute to show a
write everywhere, so an isolate elsewhere may try the provider once more after
the block. A deploy does not clear it. `/api/health` reports the platform-wide
blocks (see [Operations](./operations.md#health)).

## The kill switches

Two platform settings force a provider to fail for every tenant:
`force_fnb_down` and `force_gaso_down`. A platform operator sets them on
`/dashboard/ajustes`, which posts to `POST /api/platform/settings`
([`routes/platform.ts`](../apps/backend/src/routes/platform.ts)). A tenant admin
sees them, read-only, on the business's Ajustes page
([`domains/settings/system.ts`](../apps/backend/src/domains/settings/system.ts)).

Forcing both down makes every check an outage.

## Looking up a DNI

A platform operator can check a DNI outside any conversation:

```sh
curl -b "session=<token>" https://sales.rising.sh/api/providers/<dni>
```

It runs the same parallel check with no conversation, so no catalog is
consulted. `?tenant=<tenant id>` names the tenant whose Cálidda login the FNB
leg runs on; without it FNB reports it needs a tenant and the answer comes from
the Power BI report
([`routes/providers.ts`](../apps/backend/src/routes/providers.ts)). The
platform's Proveedores page, `/dashboard/providers`, offers the tenant picker
and calls it.
