# Eligibility

The bot sells on credit that Cálidda, Lima's natural-gas distributor, extends to
its customers. Before it offers anything, it checks the customer's DNI against
two Cálidda sources and learns whether they qualify, for how much, and under
which program.

These are one business's rules written into code. The providers, the thresholds
and the segment names are fixed, and every tenant shares them. So does the copy:
the bot introduces itself as Cálidda for every tenant. What a tenant configures
is its own Cálidda login, plus its catalog, periods and personas. Onboarding a
business that does not sell on Cálidda credit needs code changes first.

## The two providers

| Segment | Source                                               | Client                                                                          |
| ------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| FNB     | Cálidda's web API: a login, then a credit-line query | [`fnb-client.ts`](../apps/backend/src/adapters/providers/fnb-client.ts)         |
| GASO    | A public Cálidda Power BI report: four queries       | [`powerbi-client.ts`](../apps/backend/src/adapters/providers/powerbi-client.ts) |

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
`powerbi_model_id`) that a platform operator enters on the same page. A tenant
with no login, or a platform with no report ids or no base URL, fails that
provider's checks as unavailable, the same as an outage. Saving a login drops
the tenant's cached FNB session and its breaker block, so the next check
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

[`mapper.ts`](../apps/backend/src/domains/eligibility/mapper.ts) turns the
winning answer into the `eligibility_result` core reads:

- **Segment.** An approval with an NSE is `gaso`, any other approval is `fnb`.
  FNB never sends an NSE, and a Power BI approval with an empty NSE also becomes
  `fnb`.
- **Catalog.** The tenant's active bundles for that segment. A GASO customer is
  offered only bundles priced at or under their credit. An FNB customer is
  offered bundles above it too.
- **Status.** `eligible`, `not_eligible`, `system_outage`, or `needs_human` when
  the check threw.

The result is written to the conversation's metadata and to the columns `dni`,
`client_name`, `segment`, `credit_line` and `nse`. Which provider answered is
not stored.

## What the customer sees

[`phases/checking-eligibility.ts`](../packages/core/src/conversation/phases/checking-eligibility.ts)
and
[`phases/collecting-age.ts`](../packages/core/src/conversation/phases/collecting-age.ts):

| Result                     | The bot                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- |
| FNB, credit S/ 100 or more | congratulates them on the amount and lists the product groups they can afford         |
| FNB, credit under S/ 100   | says they do not qualify and closes                                                   |
| GASO                       | asks their age; under 25 it closes, otherwise it lists the categories they can afford |
| not eligible               | offers to try another DNI. After the third DNI that fails, it closes                  |
| system outage              | says nothing. The conversation waits in `waiting_for_recovery`                        |
| the check threw            | sends a holding message and escalates to a person                                     |

The minimum credit is `MIN_CREDIT_THRESHOLD` in
[`fnb-logic.ts`](../packages/core/src/eligibility/fnb-logic.ts). The minimum age
is `MIN_AGE` in `collecting-age.ts`. The age is asked but not stored.

## Outages and recovery

When both providers fail, the backend emits `system_outage_detected`, which
alerts the dev group, and the customer's conversation waits in
`waiting_for_recovery`. No timer retries it. An admin runs the check again for
every waiting conversation in scope:

```sh
curl -X POST -b "session=<token>" https://sales.rising.sh/api/admin/retry-eligibility
```

The dashboard has no button for it. `GET /api/admin/outage-status` counts the
conversations waiting. Both routes are in
[`routes/admin/operations.ts`](../apps/backend/src/routes/admin/operations.ts).
A pinned admin sweeps their tenant, an unpinned platform operator every open
tenant.

When one provider fails and the other answers, the backend emits
`provider_degraded`, which also alerts the dev group.

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
`force_fnb_down` and `force_gaso_down`. A platform operator with no tenant
selected sets them on the settings page, `/dashboard/admin/settings`. A tenant
admin sees them but cannot change them
([`domains/settings/system.ts`](../apps/backend/src/domains/settings/system.ts)).

Forcing both down puts every new check into `waiting_for_recovery`.

## Simulated customers

A simulator conversation created with a persona skips both providers. The
persona's answer is returned as both providers' answer
([`eligibility/shared.ts`](../apps/backend/src/domains/eligibility/shared.ts),
[`domains/personas/index.ts`](../apps/backend/src/domains/personas/index.ts)).
Eight personas are built in and every tenant sees them: FNB with S/ 8000, 3000
and 1200; GASO with S/ 5000, 2500 and 1500; not eligible; and not found. A
tenant can add its own on the Personas page. A simulator conversation without a
persona queries the real providers.

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
dashboard's Proveedores tile, shown to platform operators only, offers the
tenant picker and calls it.
