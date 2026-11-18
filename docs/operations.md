# Operations

This is for whoever runs a deployment and answers when it breaks. How to deploy
is in [Deploy](./deploy.md).

## What runs

| Worker              | Runs on                             | Does                                                                           |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| `vendeya-backend`   | `/api/*` and `/media/*` of the host | the webhook, the API, catalog images, the conversation objects, the cron sweep |
| `vendeya-dashboard` | every other path of the host        | the dashboard pages, which call the backend through the `BACKEND` binding      |

The backend's cron trigger runs the sweep every minute
([`sweep.ts`](../apps/backend/src/sweep.ts)):

- It wakes each conversation with work its own alarm cannot know about: a reply
  due to send, messages waiting for a turn, a failed turn, a handoff not yet
  made. One sweep wakes at most `MAX_WAKES_PER_SWEEP` of them; the rest are
  taken by the next minute's sweep.
- It hands an assignment that was not accepted in time to the next agent.
- At minute 0 of each hour it deletes processed inbox rows and finished outbox
  rows past their retention.

A task of the sweep that throws is logged as "Scheduled task failed", with the
task's name. The other tasks still run, and the task runs again the next minute.

`wrangler dev` does not run the cron trigger. Run one sweep locally with:

```sh
curl http://localhost:8787/cdn-cgi/local/scheduled
```

Nothing is checked when a Worker starts. A missing LLM key shows up the first
time it is used. The provider credentials are not on the Worker at all: each
tenant's Cálidda login and the platform's Power BI report ids are settings,
entered on `/dashboard/admin/settings` (see
[Eligibility](./eligibility.md#the-two-providers)). A tenant with no Cálidda
login, or a platform with no report ids, gets the unavailable path on every
check.

## Variables and secrets

Variables live in `vars` of
[`apps/backend/wrangler.jsonc`](../apps/backend/wrangler.jsonc). A change to one
takes effect at the next deploy. Secrets are set with `wrangler secret put` and
take effect at once. Locally, `apps/backend/.dev.vars` sets both and overrides
the values in `wrangler.jsonc`.

| Name                                         | Kind     | Without it                                                                                                             |
| -------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ENVIRONMENT`                                | variable | anything but `production` serves the simulator routes, and a 500 carries the error's message and stack                 |
| `PUBLIC_URL`                                 | variable | image links, alert links and the CORS origin name `http://localhost:5173`; cookies are secure only when it is `https:` |
| `GRAPH_API_VERSION`, `GRAPH_API_BASE_URL`    | variable | see [WhatsApp](./whatsapp.md#connecting-whatsapp)                                                                      |
| `BOT_RESPONSE_DELAY_MS`                      | variable | 2300                                                                                                                   |
| `PLATFORM_OPS_PHONE_NUMBER_ID`               | variable | alerts with no tenant have no number, unless the platform setting `platform_ops_channel_account_id` names one          |
| `WHATSAPP_GROUP_AGENT`, `WHATSAPP_GROUP_DEV` | variable | sales and dev alerts with no tenant setting have no target. See [Alerts](#alerts)                                      |
| `LOG_LEVEL`, `LOG_LEVEL_<MODULE>`            | variable | `info`. See [Logs](#logs)                                                                                              |
| `SECRETS_KEY`                                | secret   | no stored credential can be written or read                                                                            |

`SECRETS_KEY` is the only secret the Worker needs. It encrypts every credential
stored in D1: each number's access token and app secret, each tenant's OpenAI
key and Cálidda password. The credentials themselves are entered on the
dashboard or the `account` command, not in `.dev.vars` or `wrangler secret`.

In production `wrangler deploy` refuses to deploy while the secret is missing.
`WHATSAPP_PHONE_ID`, `WHATSAPP_TOKEN` and `WHATSAPP_APP_SECRET` are read only by
the seed, from `.dev.vars`. They give the default tenant its number and its Meta
credentials.

## Accounts

The seed creates no user. Every first account comes from the command line
([`cli/account.ts`](../apps/backend/src/cli/account.ts)). Each form writes to
the local D1 database, or with `--remote` to the deployed one, which reads
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the environment
([Deploy](./deploy.md#the-first-accounts)):

```sh
bun run account create <username> [--platform-operator | --tenant <tenant>] [--name <display name>]
bun run account promote <username>
bun run account tenant create <slug> --name <business name>
bun run account channel create --tenant <tenant> --phone-number-id <id> \
  [--waba-id <id>] [--display-phone-number <number>] [--label <label>]
```

`<tenant>` is a tenant's id or slug.

- `create` makes an `admin` of the tenant given by `--tenant`. With exactly one
  tenant, `--tenant` can be left off. `--platform-operator` makes a platform
  operator with no membership instead. The two flags exclude each other.
- `promote` makes an existing, active account a platform operator and keeps its
  memberships. Promoting an operator changes nothing.
- `tenant create` makes an active tenant with no number.
- `channel create` gives a tenant a WhatsApp number. It reads the access token,
  and stores it encrypted with `SECRETS_KEY`. An empty token makes the number
  `pending`. With `--remote` the key is the `SECRETS_KEY` of your shell, which
  must be the deployed key ([Deploy](./deploy.md#the-first-accounts)).

A password or an access token is read from a hidden prompt, or from stdin when
stdin is not a terminal:

```sh
printf '%s\n' "$PASSWORD" | bun run account create <username>
```

A password is asked twice and must be at least 12 characters. Neither is ever
taken from an argument or the environment. The command exits 0 on success, 1
when refused, 2 on a usage error. It applies neither the migrations nor the
seed, so run `bun run db:migrate` first. Each change is written to the audit log
with the actor `cli:<os user>`.

**When no platform operator can log in**, nobody can create a tenant from the
API, act across tenants or change platform settings. Create a new operator, or
promote an existing account, with `--remote`.

The command line cannot reset a password. The API resets a password only for a
member of the caller's active tenant (`POST /api/admin/users/:id/password`), so
an operator with no membership who lost theirs is replaced: create a new
operator.

Logins are limited to 10 attempts a minute for each client address, counted by
the `LOGIN_LIMITER` rate-limit binding. One more answers 429.

## Files

Files live in the R2 bucket `vendeya-files`. Every key starts with the owning
tenant's id. The keys come from
[`lib/storage-paths.ts`](../apps/backend/src/lib/storage-paths.ts):

| Key                        | Holds                              | Read by                                                                                            |
| -------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `<tenant>/images/<id>.jpg` | catalog images, named by random id | anyone, at `/media/<key>`, cached for a year, because Meta fetches image links with no credentials |
| `<tenant>/contracts/...`   | signed contracts                   | nobody directly. Only `GET /api/assets/:id`, after checking the caller's tenant                    |
| `<tenant>/recordings/...`  | call recordings                    | nobody directly. Only `GET /api/assets/:id`, after checking the caller's tenant                    |

The `IMAGES` binding fits an uploaded catalog image inside 1024 × 1024 px,
without enlarging it, and stores it as JPEG. A request body is limited by the
Cloudflare plan of the zone, 100 MB on the Free and Pro plans. The webhook holds
Meta's body to 3 MiB (see [Connecting WhatsApp](./whatsapp.md#body-size)).

The seed uploads the sample catalog's photos, which ship in
`apps/backend/src/db/seed-data/images`. It leaves alone an object that is
already there.

The bucket has no backup ([Deploy](./deploy.md#backups)).

## Health

```sh
curl https://sales.rising.sh/api/health
```

`GET /api/health` needs no session. It runs `SELECT 1` against D1 and answers
503 with `status: "unavailable"` when that query fails:

```json
{
  "status": "healthy",
  "database": { "status": "healthy" },
  "providers": {
    "fnb": {
      "status": "healthy",
      "available": true,
      "lastError": null,
      "blockedUntil": null
    },
    "gaso": {
      "status": "healthy",
      "available": true,
      "lastError": null,
      "blockedUntil": null
    },
    "powerbi": {
      "status": "healthy",
      "available": true,
      "lastError": null,
      "blockedUntil": null
    }
  },
  "timestamp": "2026-11-17T10:10:58.355Z"
}
```

When the database answers, `status` is `healthy` if the `fnb` and `gaso` entries
are available, and `degraded` otherwise. Two things follow from how that is
computed:

- The circuit breaker blocks `powerbi`, never `gaso`, and `powerbi` is not in
  the computation. A blocked Power BI leaves `status` unchanged.
- `providers` is the platform-wide circuit breaker's state in KV and the last
  error it recorded. FNB blocks are per tenant and do not appear here. It is not
  a live check of the providers.

`lastError` carries the provider's raw error message.

## Logs

Both Workers send their logs to Workers Logs, which the Cloudflare dashboard
shows under **Workers & Pages > vendeya-backend > Logs**. Each entry is an
object with `level`, `module` and `message`, plus the fields of the call, such
as `tenantId`. A failure carries an `error` object with `name`, `message`,
`stack` and its `cause`. Filter by any of these fields in the dashboard's query
builder.

`LOG_LEVEL` sets the lowest level written: `debug`, `info`, `warn`, `error` or
`silent`. `LOG_LEVEL_<MODULE>` overrides it for one module, as
`LOG_LEVEL_WEBHOOK=debug`.

To follow the backend's logs live from a terminal:

```sh
bunx wrangler tail vendeya-backend --format=pretty
```

## Alerts

Alerts are WhatsApp messages sent by the backend on events
([`domains/notifications/config.ts`](../apps/backend/src/domains/notifications/config.ts)):

| Event                                                  | Goes to                                   |
| ------------------------------------------------------ | ----------------------------------------- |
| escalation, attention required, order created          | the assigned agent, else the sales target |
| customer message to a held conversation                | the assigned agent only                   |
| agent assigned                                         | the agent's phone                         |
| system error, outage, provider degraded, loop exceeded | the dev target                            |

The sales target is the tenant setting `whatsapp_group_sales`, else
`WHATSAPP_GROUP_AGENT`. The dev target is `whatsapp_group_dev`, else
`WHATSAPP_GROUP_DEV`. A tenant admin sets the tenant values:

```sh
curl -X POST -b "session=<token>" -H 'content-type: application/json' \
  -d '{"whatsapp_group_sales":"<number or group id>"}' \
  https://sales.rising.sh/api/admin/settings
```

An alert about a tenant goes out on the event's own number, else the tenant's
default number. A tenant with no number gets no alert: the trace is recorded as
failed with reason `no_channel_account`, and the alert never leaves from the
platform operations number. An alert with no tenant, such as both eligibility
providers being down, goes out on the platform operations number: the account
the platform setting `platform_ops_channel_account_id` names, else
`PLATFORM_OPS_PHONE_NUMBER_ID`. Every decision is recorded in
`notification_traces`.

`WHATSAPP_GROUP_AGENT` and `WHATSAPP_GROUP_DEV` are VendeYa's own operations
groups. They receive the alerts of every tenant that has no setting of its own,
and those alerts carry the customer's name, phone and DNI, so they must hold
only VendeYa staff. A business that wants its own alerts gets
`whatsapp_group_sales` and `whatsapp_group_dev` set.

Alert links and the backend's CORS origin come from `PUBLIC_URL`, the address
image links use too, with any trailing slash removed (`publicOrigin` in
[`config.ts`](../apps/backend/src/config.ts)).

## The audit log

Writes made through the API record who did what in `audit_log`: user, catalog,
period, order, conversation, channel account, tenant and settings changes, and
the eligibility retry sweep. Each row has the actor (`user:<id>` or
`cli:<os user>`), the tenant, the action and the resource. The writer is
[`platform/audit/logger.ts`](../apps/backend/src/platform/audit/logger.ts).

Admins read it at `/dashboard/admin/audit`, backed by `GET /api/admin/audit`. A
pinned admin sees their tenant. An unpinned operator also sees platform actions.
A `send_message` row whose delivery WhatsApp did not confirm carries a "Entrega
sin confirmar" mark; see [the send](./conversation.md#the-send).

## Reading the database

`wrangler d1 execute` runs SQL against the database, from `apps/backend`. Leave
off `--remote` for the local one:

```sh
bunx wrangler d1 execute vendeya --remote \
  --command "SELECT id, status, last_kind, last_reason FROM outbox ORDER BY id DESC LIMIT 10"
```

## When customers get no reply

| Check                                    | Where                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| Webhooks arrive at all                   | the backend's logs: "Webhook POST rejected" or "refused" names the signature, size or secret |
| The tenant's OpenAI key is set           | `_has_openai_api_key` in `GET /api/admin/settings`; the dashboard's status names it too      |
| The number is `active`                   | `GET /api/admin/channels`                                                                    |
| The tenant is not suspended              | `GET /api/tenants`                                                                           |
| The turn failed                          | the log line "Message processing failed", and the dev alert                                  |
| The reply failed to send                 | `messages.status` `failed` or `queued`; the `outbox` row's `last_kind` and `last_reason`     |
| The sweep runs                           | the backend's logs for "Scheduled task failed", and its cron events in the dashboard         |
| The conversation is waiting on providers | phase `waiting_for_recovery`; see [Eligibility](./eligibility.md#outages-and-recovery)       |
| The conversation is with a person        | phase `escalated`; the bot stays silent until release                                        |

Failed turns and interrupted sends are retried and handed off as
[Conversation](./conversation.md#the-inbox-and-the-aggregator) describes.
`message_inbox.last_error` keeps the error. The inbox rows are not in the
dashboard, but the conversation is.
