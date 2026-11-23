# Deploy

This page owns how VendeYa is deployed to Cloudflare: the resources, the
secrets, the first deploy, the deploys from GitHub Actions, and backups. For
what the Workers do once they run, see [Architecture](./architecture.md) and
[Operations](./operations.md).

VendeYa is two Workers on one hostname. `vendeya-backend` answers `/api/*` and
`/media/*`. `vendeya-dashboard` answers every other path. The repository deploys
them to `sales.rising.sh`.

## What you need

- A Cloudflare account on the Workers Paid plan. The plan raises the CPU limit
  per request, which a bot turn needs.
- A zone on that account, to hold the hostname.
- Wrangler logged in to that account, from the repository root:

  ```sh
  bunx wrangler login
  ```

- The repository installed as in [Get started](./get-started.md#install).

Run every command below from `apps/backend` unless it says otherwise.

## To deploy your own copy

Change these values in both configuration files before the first deploy:

| File                           | Value                                                                   |
| ------------------------------ | ----------------------------------------------------------------------- |
| `apps/backend/wrangler.jsonc`  | `routes`: your hostname in each `pattern`, and your zone in `zone_name` |
| `apps/backend/wrangler.jsonc`  | `vars.PUBLIC_URL`: `https://` and your hostname                         |
| `apps/frontend/wrangler.jsonc` | `routes`: your hostname, as the custom domain                           |

## Create the resources

`apps/backend/wrangler.jsonc` holds the ids of the database and the KV namespace
on the rising account. A deploy to another account creates its own database, KV
namespace and bucket:

```sh
bunx wrangler d1 create vendeya
bunx wrangler kv namespace create vendeya
bunx wrangler r2 bucket create vendeya-files
```

Each of the first two prints an id. Put them in `apps/backend/wrangler.jsonc`:

- the D1 id in `d1_databases[0].database_id`;
- the KV id in `kv_namespaces[0].id`.

The login rate limit's `namespace_id`, `1001`, must be unique among the rate
limits on the account. Change it if another Worker already uses `1001`.

The Durable Object namespace, the Images binding and the cron trigger need no
step. `wrangler deploy` creates them from the configuration.

Create the tables in the new database:

```sh
bun run db:migrate:remote
```

## Secrets

The backend refuses to deploy until every secret in `secrets.required` of
`apps/backend/wrangler.jsonc` is set.

| Secret        | Value                                                               |
| ------------- | ------------------------------------------------------------------- |
| `SECRETS_KEY` | `bun scripts/generate-token.ts secrets`, run at the repository root |

`SECRETS_KEY` is the only secret the Worker needs. It is the root key that
encrypts every credential stored in D1 — each number's WhatsApp access token and
Meta app secret, and each tenant's OpenAI key and Cálidda password. Those
credentials are entered after the deploy: each tenant's OpenAI key and Cálidda
login by its admin on the business's Ajustes page
(`/dashboard/<tenant id>/admin/settings`), each number's credentials on its
Canales page (`/dashboard/<tenant id>/admin/channels`) or the
`account channel create` command (see [Connecting WhatsApp](./whatsapp.md)).
Saving one takes effect at once, without a deploy.

`CALIDDA_BASE_URL` stays a plain variable in `wrangler.jsonc` — the Cálidda API
host is the same for every business. The Power BI report's four ids are platform
settings an operator enters on `/dashboard/ajustes` (see
[Eligibility](./eligibility.md#the-two-providers)).

Write `SECRETS_KEY` to a file outside the repository, such as
`~/vendeya-production.env`. Keep a copy somewhere safe. Without it no stored
credential can be read, and a new key cannot read the old ones.

To change the secret later:

```sh
bunx wrangler secret put SECRETS_KEY
```

A secret takes effect at once, without a deploy. Secrets are never deleted by a
deploy.

## The first deploy

Deploy the backend first, with the secrets file. The dashboard's service binding
names the backend, which must exist.

```sh
bunx wrangler deploy --secrets-file ~/vendeya-production.env
```

Wrangler lets a variable set in your shell override the same name in the file.
Run it from a shell with none of those names set.

Then the dashboard, from the repository root:

```sh
bun run --cwd apps/frontend build
bun run --cwd apps/frontend deploy
```

The dashboard's deploy adds the hostname to the zone as a custom domain, with
its DNS record and certificate. The backend's deploy adds the `/api/*` and
`/media/*` routes on the same hostname.

Check both from outside:

```sh
curl https://sales.rising.sh/api/health
curl -I https://sales.rising.sh/login
```

The first answers JSON with `"status":"healthy"`. The second answers `200`.

## The first accounts

The `account` command writes to the deployed database with `--remote`, over the
Cloudflare API. It needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in
the shell — the same two values the
[deploy workflow](#deploys-from-github-actions) uses — never `wrangler login`.
The token needs **Account > D1 > Edit**. A fresh deployment needs one platform
operator; businesses then sign up on the dashboard. Run this at the repository
root:

```sh
bun run account create <email> --platform-operator --remote
```

An operator can also open a business and its admin by hand:

```sh
bun run account tenant create --name "<business name>" --remote
bun run account create <email> --tenant <tenant id> --remote
```

A channel account stores the number's access token encrypted. With `--remote`
the command encrypts with the `SECRETS_KEY` in your shell, never the one in
`.dev.vars`. Give it the deployed key:

```sh
SECRETS_KEY=<the deployed key> bun run account channel create \
  --tenant <tenant id> --phone-number-id <id> --remote
```

It reads the access token from a hidden prompt.
[Connecting WhatsApp](./whatsapp.md) says where each value comes from, and how
to point Meta's webhook at `https://<hostname>/api/webhook`.

Nothing seeds the deployed database. Each business enters its own catalog.

## Deploys from GitHub Actions

[`deploy.yml`](../.github/workflows/deploy.yml) runs on every push to `master`.
Its first job, `check`, runs the CI workflow. No deploy job starts unless the
check passes, so a red commit never migrates the database. The workflow then
deploys only the Workers whose inputs the push changed:

| Job         | Runs when a push changes                                                           | Steps                                       |
| ----------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `backend`   | `apps/backend`, `packages/{intelligence,types,utils,tsconfig}`, the root manifests | `db:migrate:remote`, then `wrangler deploy` |
| `dashboard` | `apps/frontend`, `packages/{types,tsconfig}`, the root manifests                   | `vite build`, then `wrangler deploy`        |

Migrations run before the new code, so the code never reads a column the
database lacks. The dashboard job waits for the backend job when both run.

The workflow reads two secrets. The risinghq organization gives both to its
public repositories. A fork or a private copy adds them on GitHub under
**Settings > Secrets and variables > Actions**:

| Secret                  | Value                                                                      |
| ----------------------- | -------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | the account id, on the Cloudflare dashboard's **Workers & Pages** overview |
| `CLOUDFLARE_API_TOKEN`  | an API token, made as below                                                |

To make the token, open **My Profile > API Tokens** on the Cloudflare dashboard
and select **Create Token**. Start from the **Edit Cloudflare Workers**
template. Add the permission **Account > D1 > Edit**, which the migration step
needs. Limit the account resources to your account and the zone resources to
your zone, then create the token.

## Backups

The database's backup is D1 Time Travel. It keeps every change of the last 30
days, with no setup. To restore the database to a moment:

```sh
bunx wrangler d1 time-travel info vendeya --timestamp=2026-11-17T09:00:00Z
bunx wrangler d1 time-travel restore vendeya --timestamp=2026-11-17T09:00:00Z
```

The first prints the bookmark for that moment. The second restores to it and
prints a bookmark of the state it replaced, which undoes the restore. A restore
replaces the whole database for every tenant.

The R2 bucket has no backup. Catalog images can be uploaded again, and the seed
uploads its own. Contracts and recordings have no other copy.
