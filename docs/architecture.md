# Architecture

This is the code map for contributors. It names the Workers and their bindings,
how a message becomes a reply, and the owner of each change. The user-facing
flow is in [How a conversation runs](./conversation.md).

## Workspaces

| Workspace               | Owns                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend`          | The backend Worker: the Hono API, the webhook, the conversation Durable Object, the cron sweep, provider calls, authentication and tenancy. |
| `apps/frontend`         | The dashboard Worker: SvelteKit 3 with Svelte 5 on `@sveltejs/adapter-cloudflare`, and its server-side session check.                       |
| `apps/cli`              | The `vendeya` command line: an API client that acts with an API token, for people and agents.                                               |
| `packages/intelligence` | The model call: `createCompletion` sends messages and tool definitions to OpenAI and returns the reply or tool calls.                       |
| `packages/types`        | Types shared by the applications and packages.                                                                                              |
| `packages/utils`        | The trace-id helper.                                                                                                                        |
| `packages/tsconfig`     | TypeScript configuration bases used by the workspaces.                                                                                      |

Workspace dependencies point inward:

```text
types, utils, tsconfig
intelligence    -> types
backend         -> intelligence, types, utils
frontend        -> types
cli             -> types
```

## Workers and bindings

VendeYa is two Workers on one host.

| Worker              | Serves                                 | Configuration                                                     |
| ------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| `vendeya-backend`   | `/api/*` and `/media/*`, the cron      | [`apps/backend/wrangler.jsonc`](../apps/backend/wrangler.jsonc)   |
| `vendeya-dashboard` | every other path, as the custom domain | [`apps/frontend/wrangler.jsonc`](../apps/frontend/wrangler.jsonc) |

The backend's routes on the host win over the dashboard's custom domain. So
Meta's webhook, the browser's API calls and Meta's image fetches go straight to
the backend. The dashboard's server code calls the backend through the `BACKEND`
service binding, without a public hop. Under `vite dev` and `wrangler dev`,
where there are no routes, the dashboard's
[`hooks.server.ts`](../apps/frontend/src/hooks.server.ts) passes `/api/*` and
`/media/*` to the same binding.

They are two Workers because the SvelteKit adapter writes the dashboard Worker's
entry point. The backend's entry point,
[`src/index.ts`](../apps/backend/src/index.ts), exports the Hono app, the
`scheduled` handler and the Durable Object class.

The backend's bindings:

| Binding         | Kind           | Holds                                                               |
| --------------- | -------------- | ------------------------------------------------------------------- |
| `DB`            | D1             | Every table, for every tenant.                                      |
| `CONVERSATIONS` | Durable Object | `ConversationObject`, one per conversation.                         |
| `KV`            | KV             | The per-tenant FNB session tokens and the provider circuit breaker. |
| `FILES`         | R2             | Catalog images, and private files served after a scope check.       |
| `IMAGES`        | Images         | Resizes an uploaded catalog image to a 1024 px JPEG.                |
| `LOGIN_LIMITER` | Rate limit     | Login attempts: 10 per minute per client address.                   |

Code reads bindings and secrets from `env` in `cloudflare:workers`. The Worker
uses no `nodejs_compat` flag.

## Request path

```text
Meta
  POST /api/webhook
apps/backend  routes/webhook.ts
  verifies the signature, routes by phone_number_id, deduplicates, stores the
  message as a message_inbox row, wakes the conversation's object, answers 200
conversation/object.ts  ConversationObject
  one per conversation; its alarm fires when the quiet window ends
conversation/aggregator.ts
  groups the contact's pending messages and starts one turn
conversation/handler/orchestrator.ts
  runs the turn: asks the assistant, sends, records the turn
domains/assistant/agent.ts
  calls the model with the conversation and the tools, runs the tool calls,
  returns the reply and the tools' effects
adapters/whatsapp/index.ts
  sends through CloudApiAdapter
conversation/outbox-sender.ts
  retries recoverable failures on the object's alarm; handoff.ts escalates a
  failed reply or turn
shared/events + bootstrap/event-bus-setup.ts
  dispatch domain events such as orders and escalation alerts
```

The webhook answers Meta once the rows are stored. The turn runs on the object's
alarm, after the response. The complete turn, including the assistant and
failure states, is in [How a conversation runs](./conversation.md). The Cálidda
credit check is in [Eligibility](./eligibility.md).

## Durable state

### D1

One D1 database holds every tenant. Every tenant-owned row carries `tenant_id`.
The schema is the wrangler migrations in
[`apps/backend/migrations/`](../apps/backend/migrations/), applied in order by
`wrangler d1 migrations apply`. A schema change is a new numbered file. Never
edit a migration that has run remotely.

Queries go through [`db/index.ts`](../apps/backend/src/db/index.ts). `db` is a
Kysely builder typed by [`db/schema.ts`](../apps/backend/src/db/schema.ts),
which `bun run db:types` generates from the migrations. A wrong table, column or
value type fails the typecheck. The catalog, stock and conversation domains use
it. The other domains still use the raw helpers `getOne`, `getAll` and `run`,
and move to `db` one domain at a time.

D1 has no interactive transaction, so `db.transaction()` throws. A multi-step
write is one `batch()`, which takes Kysely queries and raw statements. The
conversation's object keeps a second writer out.

| Area                | Tables                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------- |
| Tenancy and auth    | `tenants`, `users`, `tenant_memberships`, `session`                                    |
| Channel credentials | `channel_accounts`, encrypted `channel_secrets`                                        |
| Catalog             | `catalog_periods`, `products`, `product_variants`, `product_images`, `catalog_bundles` |
| Stock               | `stock_locations`, `stock_levels`, `stock_movements`                                   |
| Conversations       | `conversations`, `messages`, `message_inbox`, `outbox`, `unread_alerts`                |
| Customers           | `customers`, `customer_addresses`                                                      |
| Orders              | `orders`, `order_lines`, `payments`, `shipments`, `delivery_zones`, `payment_methods`  |
| Records             | `assets`, `llm_calls`, `notification_traces`, `audit_log`                              |
| Settings            | `system_settings`, `tenant_settings`                                                   |

A conversation row holds who it is with, its status, who holds it and when it
was last active. It stores no state for the assistant, which reads the messages.
The customer's name and details are the `customers` row with the conversation's
phone number.

### The conversation's Durable Object

[`ConversationObject`](../apps/backend/src/conversation/object.ts) serializes
every write that must not interleave with a bot turn: the turn, the outbox
sends, the handoff, a takeover, a release, a decline and a timed-out
reassignment. Its name is `tenant:channel account:phone number`, so the same
contact on two businesses has two objects. The lock lives in the object's
memory, and each object runs in one place at a time.

The object's alarm is the conversation's next due moment: the end of the quiet
window of its pending messages, or the next outbox attempt. Each locked call
sets the alarm again from D1. The object's own storage holds only the
conversation's identity, which the alarm handler needs.

A row left `processing` or `sending` belongs to a call that ended mid-turn: the
object died with it, or the write that records the outcome threw. Every locked
call settles those rows before anything else, because the lock means none of
them can still be running.

### The cron sweep

The cron trigger runs [`sweep.ts`](../apps/backend/src/sweep.ts) every minute.
It wakes the objects of conversations that are due, which their own alarm may
not know: a number or tenant switched back on, a lost wake, a row an ended
instance left mid-flight. One sweep wakes at most `MAX_WAKES_PER_SWEEP`
conversations, because each wake spends one of the invocation's subrequests; a
bigger backlog drains over successive sweeps. It hands assignments not taken
within 5 minutes to the next agent, oldest first and bounded the same way. Once
an hour it deletes processed inbox rows and finished outbox rows past their
retention.

### Shared stores

Every isolate sees the same values:

| State                                         | Store                     | Owner                                                                                      |
| --------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| Conversation lock and quiet window            | the conversation's object | [`conversation/object.ts`](../apps/backend/src/conversation/object.ts)                     |
| The provider circuit breaker                  | KV, with a TTL            | [`adapters/providers/health.ts`](../apps/backend/src/adapters/providers/health.ts)         |
| The FNB session token, shared by every tenant | KV, with a TTL            | [`adapters/providers/fnb-client.ts`](../apps/backend/src/adapters/providers/fnb-client.ts) |
| Login attempts                                | the rate-limit binding    | [`middleware/security.ts`](../apps/backend/src/middleware/security.ts)                     |

KV is eventually consistent. Two isolates may each log in to FNB once, or see
the breaker open a few seconds late. Neither changes a result.

### Files

R2 keys start with the tenant id. They are built only in
[`lib/storage-paths.ts`](../apps/backend/src/lib/storage-paths.ts).

| Key                        | Served                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| `<tenant>/images/<id>.jpg` | `/media/<key>`, without a session, cached for a year as immutable |
| `<tenant>/contracts/...`   | only `/api/assets/:id`, after a tenant scope check                |
| `<tenant>/recordings/...`  | only `/api/assets/:id`, after a tenant scope check                |

No code writes a private file today. The route and its checks stay for the next
one, such as a customer's payment receipt.

Catalog images are public because Meta fetches an outgoing image's link with no
credentials. The image id holds 60 random bits, so a key cannot be guessed. An
image's bytes never change under its key.

### Who holds a conversation

`conversations.assigned_agent` is either empty (nobody holds the conversation)
or a user id (that user does). A `sales_agent` reaches only the conversations
that are empty or hold their own id
([`platform/auth/scope.ts`](../apps/backend/src/platform/auth/scope.ts)), so a
held conversation is hidden from the other agents. Every other role reaches all
of them.

| Transition                  | Actor                              | Where                                                                         |
| --------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| empty to the taker          | the agent who takes over           | `takeoverConversation`, under the conversation lock                           |
| empty to the next agent     | a handoff, by the round-robin      | [`assignment.ts`](../apps/backend/src/domains/conversations/assignment.ts)    |
| held to the next agent      | the holder declines                | `declineAssignment`, which hands it to the round-robin under the lock         |
| held to the next agent      | the minute sweep                   | `checkAndReassignTimeouts`, for an assignment not taken over within 5 minutes |
| held to empty, on hand-back | release, or the 3 h idle release   | `release` and `releaseIfIdle` in `conversation/store.ts`                      |
| held to empty, user leaves  | removal, role change, deactivation | `MembershipService.remove`, `upsert` on a changed role, `clearAllAssignments` |
| held to another holder      | nobody                             | takeover answers 409 while someone else holds the conversation                |

A takeover reads the holder and writes the taker under the conversation lock, so
of two simultaneous takers one wins and the other gets 409. The holder repeating
a takeover succeeds. A user who loses their membership, their role or their
account does not get a conversation back when they return.

### Unread alert

`unread_alerts` holds one row per conversation whose holder was alerted and has
not answered since. A conversation is either `none` (no row) or `unread` (a
row). Only `none` lets a customer message to a held conversation alert the
assigned agent.

| Transition     | When                                                                                                                | Owner                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| none to unread | a bot turn hands the conversation off, after it is assigned                                                         | `answerMessage` in [`orchestrator.ts`](../apps/backend/src/conversation/handler/orchestrator.ts), `raiseUnreadAlert`      |
| none to unread | a failed reply or turn hands the conversation to a person                                                           | `handOff` in [`handoff.ts`](../apps/backend/src/conversation/handoff.ts), `raiseUnreadAlert`                              |
| none to unread | a customer message reaches a `human_takeover` conversation whose agent has a phone                                  | `claimMessageAlert` in [`unread-alerts.ts`](../apps/backend/src/conversation/unread-alerts.ts), one atomic insert         |
| unread to none | the holder sends a message                                                                                          | `sendManualMessage`, `clearUnreadAlert`, after the send succeeded                                                         |
| unread to none | `assigned_agent` is written: assignment, reassignment, decline, takeover, release, idle release, an agent's removal | the trigger `conversations_assignment_clears_unread_alert` in [`0001_init.sql`](../apps/backend/migrations/0001_init.sql) |
| unread to none | none of the alert's notifications went out                                                                          | `notify` in [`notify.ts`](../apps/backend/src/domains/notifications/notify.ts)                                            |

The row is written before the alert is sent and the turn waits for the send, all
under the conversation lock, so the next message sees the row as the delivery
left it. A handoff assigns before it raises the row, because writing
`assigned_agent` removes it.

The dashboard Worker keeps no state of its own. See [Deploy](./deploy.md) for
deployment.

## Boundaries

- The assistant never acts on its own. Its tools in
  [`domains/assistant/tools/`](../apps/backend/src/domains/assistant/tools/)
  check their arguments, read and write through the business's domains, and
  return effects. The turn sends the replies and photos, files the events and
  hands off. A business shapes the assistant with its settings, not code.
- Every WhatsApp send uses `WhatsAppService` in
  [`adapters/whatsapp/index.ts`](../apps/backend/src/adapters/whatsapp/index.ts).
  It rechecks the tenant and channel account before sending and returns a typed
  outcome for most failures. An inactive account throws
  `ChannelUnavailableError` so its outbox can wait. Alerts to staff use
  `sendDirect`, which skips the suspension check.
- Tenant scope. A Kysely read takes `tenantScope(tenantId)` from
  [`db/index.ts`](../apps/backend/src/db/index.ts), and raw SQL takes
  `tenantPredicate` from [`db/query.ts`](../apps/backend/src/db/query.ts).
  Cross-tenant work, such as the sweep, uses `openTenantsOnly` and
  `activeChannelAccountsOnly`.
- Logs are one JSON object per line on `console`, which Workers Logs indexes.
  `LOG_LEVEL` sets the level, and `LOG_LEVEL_<MODULE>` overrides it for one
  module ([`lib/logger.ts`](../apps/backend/src/lib/logger.ts)).

## Where a change belongs

| Change                                | Owner                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| What the assistant can do             | A tool in [`apps/backend/src/domains/assistant/tools/`](../apps/backend/src/domains/assistant/tools/)    |
| The assistant's fixed rules           | [`apps/backend/src/domains/assistant/prompt.ts`](../apps/backend/src/domains/assistant/prompt.ts)        |
| Models a business may pick            | `ASSISTANT_MODELS` in [`packages/types/src/assistant.ts`](../packages/types/src/assistant.ts)            |
| Provider behavior or result selection | [`apps/backend/src/domains/eligibility/`](../apps/backend/src/domains/eligibility/)                      |
| WhatsApp transport                    | [`apps/backend/src/adapters/whatsapp/`](../apps/backend/src/adapters/whatsapp/)                          |
| API endpoint                          | [`apps/backend/src/routes/`](../apps/backend/src/routes/)                                                |
| Dashboard page                        | [`apps/frontend/src/routes/dashboard/`](../apps/frontend/src/routes/dashboard/)                          |
| Catalog data or rules                 | [`apps/backend/src/domains/catalog/`](../apps/backend/src/domains/catalog/)                              |
| Stock levels, locations or movements  | [`apps/backend/src/domains/stock/`](../apps/backend/src/domains/stock/)                                  |
| New table or column                   | A new file in [`apps/backend/migrations/`](../apps/backend/migrations/)                                  |
| Binding, variable, route or cron      | [`apps/backend/wrangler.jsonc`](../apps/backend/wrangler.jsonc), then `bun run --cwd apps/backend types` |
| Notification recipient or text        | [`apps/backend/src/domains/notifications/`](../apps/backend/src/domains/notifications/)                  |
| R2 key layout                         | [`apps/backend/src/lib/storage-paths.ts`](../apps/backend/src/lib/storage-paths.ts)                      |

## Tests that enforce structure

| Test                                                 | Holds                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/tests/created-at-contract.test.ts`     | INTEGER `*_at` fields reach clients as milliseconds.                                                                            |
| `apps/backend/tests/foreign-keys.test.ts`            | The schema's foreign keys and cascades hold in D1.                                                                              |
| `apps/backend/tests/unit/tenant-scope-guard.test.ts` | No backend query reads tenant rows without the scope helpers in `db/query.ts`.                                                  |
| `apps/backend/src/db/tenant-scope.ts`                | At run time, a Kysely query that reads, updates or deletes a tenant table with no tenant predicate throws before it reaches D1. |
| `apps/backend/tests/unit/db-schema.test.ts`          | `db/schema.ts` matches the migrations.                                                                                          |

The commands and CI jobs are in [Development](./development.md).
