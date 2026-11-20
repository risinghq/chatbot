# Development

This covers the checks, what CI runs, where versions are pinned, how the tests
are laid out, and the conventions a change follows. Where a change belongs is in
[Architecture](./architecture.md#where-a-change-belongs).

## Checks

Run from the repository root. [mise](https://mise.jdx.dev) installs the pinned
tools, and the scripts in the root [`package.json`](../package.json) are the
checks.

| Command                         | What it does                                                            |
| ------------------------------- | ----------------------------------------------------------------------- |
| `bun install --frozen-lockfile` | installs from `bun.lock` and fails if the lockfile is out of date       |
| `bun run lint`                  | Biome lint and format check on code, oxfmt check on the rest            |
| `bun run fix`                   | Biome safe fixes and formatting, oxfmt formatting. It writes files      |
| `bun run typecheck`             | `typecheck` in every workspace: tsc, and svelte-check for the dashboard |
| `bun run test`                  | `test:bun`, then `test:workers`                                         |
| `bun run test:bun`              | the tests that need no Workers runtime, under `bun test`                |
| `bun run test:workers`          | the backend's tests, under vitest inside workerd                        |
| `bun run build`                 | the dashboard build, then `wrangler deploy --dry-run` for both Workers  |
| `bun run check`                 | `lint`, `typecheck`, `test` and `build`. It needs no Cloudflare account |

`lint` and `fix` have parts, `lint:js`, `lint:fmt`, `fix:js` and `fix:fmt`.
Biome formats code. oxfmt formats Markdown, YAML and JSON.

Each Worker's `typecheck` first runs `wrangler types`, which writes the `Env`
type of the bindings in its `wrangler.jsonc` to `worker-configuration.d.ts`. Git
ignores that file. A binding renamed in `wrangler.jsonc` but not in the code
fails the typecheck.

## What CI runs

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) installs the pinned
tools with mise, runs `bun install --frozen-lockfile`, then `bun run check`. It
runs on every pull request, and on every push to `master` as the first job of
[`deploy.yml`](../.github/workflows/deploy.yml).

[`codeql.yml`](../.github/workflows/codeql.yml) adds `analyze (actions)` and
`analyze (javascript-typescript)`. `deploy.yml` deploys the changed Workers
after the check passes, as [Deploy](./deploy.md#deploys-from-github-actions)
describes. Branch protection is configured on GitHub rather than in this
repository and is not described here.

A `package.json` change without its `bun.lock` update fails
`bun install --frozen-lockfile`.

A new workspace needs a `typecheck` script, which `bun run typecheck` runs.

## Where the pins live

| Pin                                  | File                                                               |
| ------------------------------------ | ------------------------------------------------------------------ |
| bun, node                            | [`mise.toml`](../mise.toml), resolved in `mise.lock`               |
| wrangler, biome, oxfmt, npm packages | `bun.lock`, installed with `--frozen-lockfile`                     |
| the Workers runtime's behaviour      | `compatibility_date` in each `wrangler.jsonc`                      |
| transitive versions forced for fixes | `overrides` in the root [`package.json`](../package.json)          |
| GitHub Actions                       | the `uses:` lines in `.github/workflows/`                          |
| `typescript`                         | an alias to `typescript-native-bridge`, in the root `package.json` |

Wrangler and vitest run on Node, so mise pins it beside Bun.

`typescript-native-bridge` keeps the classic `typescript` API that SvelteKit and
`svelte-check` call and runs the TypeScript 7 (tsgo) checker behind it. The root
`overrides` entry makes every package that depends on `typescript` resolve to
it, so `tsc` and `svelte-check` both type-check with tsgo. The first check in a
process prints `TNB ACTIVE` to stderr.

`mise install` installs the pinned tools. Dependabot
([`dependabot.yml`](../.github/dependabot.yml)) updates the Bun dependencies and
GitHub Actions weekly. It does not update `mise.toml`.

To bump a pin, edit `mise.toml` to an exact version and run `mise lock` to
rewrite its entry in `mise.lock`. CI and the deploy workflow install the tools
from `mise.toml`, so a version is stated nowhere else.

## How the tests are laid out

```text
apps/backend/tests/            the backend suite, one file per behavior, in workerd
apps/backend/tests/helpers/    tenants, webhook deliveries, the Graph fake, turns
apps/backend/tests/setup.ts    runs before each backend test
apps/backend/tests/source/     tests that read source files, under bun test
packages/core/tests/           transitions, eligibility, validation, under bun test
*.test.ts beside the code      apps/frontend/src/lib, packages/core/src
```

The backend's tests run under vitest with `@cloudflare/vitest-plugin`
([`vitest.config.ts`](../apps/backend/vitest.config.ts)). Each runs inside
workerd with the bindings of `wrangler.jsonc`: D1, KV, R2, the rate limit and
the Durable Objects. Before each test, `setup.ts` empties the storage, aborts
every Durable Object and applies the migrations, so no test sees another's rows,
breaker state or lock.

The pool reads `apps/backend/.dev.vars`. The values in
[`tests/bindings.ts`](../apps/backend/tests/bindings.ts) override it, so a
developer's real credentials never reach a test. Those values point Graph and
the providers at hosts that do not resolve. `fakeGraph()` in
[`tests/helpers/graph.ts`](../apps/backend/tests/helpers/graph.ts) records each
send and fails any other request, so a test never reaches the network.

`tests/source/` reads files rather than bindings, so `bun test` runs it. It
holds the tenant scope guard, which fails on a query that bypasses the scope
helpers in `db/query.ts`.

`packages/core/tests/` is not typechecked: core's `tsconfig.json` includes `src`
only.

The tests that hold the architecture's boundaries are listed in
[Architecture](./architecture.md#tests-that-enforce-structure).

## Conventions

These are what the code does today.

- **Queries.** New code uses the Kysely `db` from
  [`db/index.ts`](../apps/backend/src/db/index.ts), not raw SQL strings.
- **Tenant scope.** A read function takes `tenantId: string | null` and filters
  with `tenantScope` (Kysely) or `tenantPredicate` (raw SQL), not a hand-built
  `if (tenantId)` branch. A write takes the tenant from `activeTenantId(c)`. A
  row fetched by id is checked with `canAccessTenant` and answers 404 when out
  of scope. See [Tenancy](./tenancy.md#how-a-read-is-scoped).
- **File keys** come from
  [`lib/storage-paths.ts`](../apps/backend/src/lib/storage-paths.ts), and each
  starts with the tenant's id.
- **Timestamps** are INTEGER milliseconds, defaulting to
  `unixepoch('now', 'subsec') * 1000`, typed `number` in `packages/types`. A
  calendar day is a Lima day: `limaRangeEdge` in `db/query.ts` on the server,
  [`formatters.ts`](../apps/frontend/src/lib/utils/formatters.ts) in the
  dashboard.
- **Booleans** are INTEGER columns with `CHECK(x IN (0, 1))`.
- **Paging.** A list route reads `limit` and `offset` with `queryLimit` and
  `queryOffset` from [`lib/http.ts`](../apps/backend/src/lib/http.ts). A bad
  value answers 400. `limit` is at most 500. A path parameter is read with
  `pathParam`.
- **Audit.** A route that changes data calls `logAction` from
  [`platform/audit/logger.ts`](../apps/backend/src/platform/audit/logger.ts).
- **Sends** go through `WhatsAppService` and act on the `SendResult` it returns.
  Most failures come back as an outcome, not a throw. An inactive number throws
  `ChannelUnavailableError`.
- **Atomic writes.** D1 has no interactive transaction. Statements that must
  commit together are one `batch()` from
  [`db/index.ts`](../apps/backend/src/db/index.ts). A write that must not
  interleave with a bot turn runs inside the conversation's Durable Object.
- **Schema.** The schema is the migrations in
  [`apps/backend/migrations`](../apps/backend/migrations). A change is a new
  file, made with `bunx wrangler d1 migrations create DB <name>` from
  `apps/backend`, never an edit to a migration that has run. Apply it locally
  with `bun run db:migrate`, then run `bun run db:types` to regenerate
  `src/db/schema.ts`. A test fails while that file is stale.
- **Commits.** A lower-case imperative subject with no prefix, then a body that
  explains why, usually starting with `Why:`. Commits to `master` are signed.
