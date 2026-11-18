# Agent guide

VendeYa is described in [readme.md](./readme.md). Read
[architecture](./docs/architecture.md) before changing code, and the manual page
for the area you touch ([docs/readme.md](./docs/readme.md)). This file holds
only the rules those documents do not.

## Rules

- **Tenant scope.** A read over a scope that may be null filters with
  `tenantPredicate` from `apps/backend/src/db/query.ts`, never with a hand-built
  `if (tenantId)` branch. Code that sweeps every tenant uses `openTenantsOnly`
  and `activeChannelAccountsOnly`. See
  [Tenancy](./docs/tenancy.md#how-a-read-is-scoped) for the current scope model.
- **File paths** come from `apps/backend/src/lib/storage-paths.ts`.
- **Core stays free of I/O.** If a turn needs the database, a provider or the
  LLM, add an enrichment request and a backend handler
  ([conversation](./docs/conversation.md#the-enrichment-loop)).
- **Sends** go through `WhatsAppService` and act on the returned outcome. Most
  failures come back as an outcome, not a throw. An inactive number throws
  `ChannelUnavailableError`.
- **No state in an isolate.** Workers run many isolates and evict them at any
  time. State that correctness depends on lives in D1, KV, R2 or a Durable
  Object. A write that must not interleave with a bot turn runs inside the
  conversation's `ConversationObject`, and its next due moment is the object's
  alarm. Use no `setInterval`; periodic work belongs in the cron sweep
  (`apps/backend/src/sweep.ts`).
- **Atomic writes.** D1 has no interactive transaction. Statements that must
  commit together are one `batch()` from `apps/backend/src/db/index.ts`.
- **Schema.** The schema is the D1 migrations in `apps/backend/migrations`. A
  change is a new migration, never an edit to one that has run.
- **A new workspace** needs a `typecheck` script, which `bun run typecheck`
  runs. Nothing checks that it has one.
- **Names.** The product and every workspace package are VendeYa (`@vendeya/*`).
  The repository is still named `chatbot`. Totem is the default tenant, a client
  business, and its slug `totem` is a lookup key for an existing row, so it is
  never renamed. Do not rename in passing.
- **Business rules.** Implement what the code and the owner say. Credit tiers,
  NSE limits and bundle rules found in old notes are not live rules.

## Before you finish

Run `bun run fix`, then `bun run check`, which is what CI runs
([Development](./docs/development.md#checks)). Report a check you could not run.

When behavior changes, change the manual page that describes it in the same
commit. A page that is wrong is worse than none.

## Environment hazards

- `bun run dev`, `seed` and `account` read `apps/backend/.dev.vars`. If it holds
  real `WHATSAPP_*` or `OPENAI_API_KEY` values, a local run uses them: it can
  seed a live number and send real messages. Point `GRAPH_API_BASE_URL` at a
  fake server for local probes.
- `seed --remote`, `account --remote` and `db:migrate:remote` write to the
  deployed D1 database and R2 bucket. Run them only when you mean to.
- The backend's tests run in workerd with their own D1, KV and R2 per test, and
  `apps/backend/tests/bindings.ts` overrides `.dev.vars`. A script run outside
  the tests uses the local state under `apps/backend/.wrangler/state`, which
  `bun run --cwd apps/backend clean` deletes.
- `wrangler dev` does not run the cron trigger. Run the sweep with
  `curl http://localhost:8787/cdn-cgi/local/scheduled`.

## Commits

A lower-case imperative subject with no prefix, then a body that explains why,
usually starting with `Why:`. `master` requires signed commits and linear
history.
