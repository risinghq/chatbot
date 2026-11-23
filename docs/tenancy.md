# Tenancy

One VendeYa deployment serves several businesses. Each business is a tenant. Its
conversations, catalog, orders and settings are its own, and its customers write
to its own WhatsApp numbers. Every tenant lives in the one D1 database. The
schema is in [`migrations/`](../apps/backend/migrations).

## Tenants

A tenant is a row in `tenants` with a UUID v7 id, a name and a status, `active`
or `suspended`. The id is the only key; the name is a label the business can
change, and two businesses may share one. Almost every other table carries
`tenant_id`. A conversation is keyed by
`(tenant_id, channel_account_id, phone_number)`, so the same contact has a
separate conversation with each business and each number.

There is no built-in business. A business joins by signing up
(`POST /api/auth/signup`, the `/registro` page): one batch creates the account,
the tenant and the admin membership, and logs the founder in. A platform
operator can also create a tenant from the command line:

```sh
bun run account tenant create --name "Acme" --remote
```

or through the API:

```sh
curl -X POST -b "session=<token>" -H 'content-type: application/json' \
  -d '{"name":"Acme"}' https://sales.rising.sh/api/tenants
```

The local seed creates a demo business with a sample catalog
([Get started](./get-started.md#the-seed)). Nothing seeds the deployed database.

A new tenant has no catalog and no channel account. A platform operator creates
one from `/dashboard/negocios` in the dashboard
([Dashboard](./dashboard.md#onboarding-a-business)); the CLI path stays for
support (`account create`, `account channel create`,
[Operations](./operations.md#accounts)). `GET /api/admin/setup-status` reports
what the new tenant still needs, and `POST /api/tenants/:id/members` accepts
`{ email, role }` as well as `{ userId, role }` so the dashboard can add a
member by the email they log in with.

A tenant's files sit under its id in R2, and each conversation's Durable Object
is named by its tenant, number and contact. A tenant shares the Workers, the
database and the bucket with every other tenant, and nothing else.

## Users, memberships and roles

A user is one global account in `users`. A membership in `tenant_memberships`
joins a user to a tenant with one role:

| Role          | Adds                                                     |
| ------------- | -------------------------------------------------------- |
| `admin`       | `/api/admin/*`: users, channel accounts, settings, audit |
| `developer`   | catalog writes, reports, system logs, the simulator      |
| `supervisor`  | catalog writes, reports, system logs                     |
| `sales_agent` | nothing beyond the base                                  |

The base is what every role can do: read the catalog, and read and work
conversations and orders. A `sales_agent` is narrowed: they list, open and act
on a conversation assigned to them or to nobody, never one assigned to another
agent, and they see the orders they created and the orders from their
conversations. Every other role sees the whole tenant. The rule is
`assignedAgentScope` in
[`platform/auth/scope.ts`](../apps/backend/src/platform/auth/scope.ts). A
takeover assigns the conversation to whoever takes it. A bot escalation assigns
nothing, so an agent reaches every conversation no other agent has claimed.
Removing a member, or changing their role, clears the assignments they held in
that tenant. Deactivating the account clears them in every tenant. The
conversations go back to nobody, and a member who is added again or an account
that is turned back on does not get them back. The assignment states and who
changes them are in [Architecture](./architecture.md#who-holds-a-conversation).
Orders split three ways, in
[`routes/orders.ts`](../apps/backend/src/routes/orders.ts):

| Action                                                 | Roles                                       |
| ------------------------------------------------------ | ------------------------------------------- |
| Take an order, record a payment, edit the shipment     | admin, developer, supervisor, `sales_agent` |
| Move an order to confirmed, packed, shipped, delivered | admin, developer, supervisor                |
| Cancel an order, confirm or reject a payment           | admin, supervisor                           |

Moving an order moves its stock, and cancelling or deciding a payment changes
what the business is owed. Role checks are `requireRole` in
[`middleware/auth.ts`](../apps/backend/src/middleware/auth.ts) and the route
files.

Authorization reads the membership role; a user has no role of their own. A user
can belong to several tenants with a different role in each. Availability for
new conversations (`is_available`) is also per membership.

A user logs in with their email, stored trimmed and lower-case and unique across
the deployment. A tenant admin brings people in by invitation
(`POST /api/admin/invitations` with `{ email, role }`). The answer carries a
link, `/invitacion/<token>`, shown once for the admin to send. Only the token's
hash is stored, and the link lasts seven days. Whoever opens it joins the tenant
with the invited role: an existing account by entering its password, a new
person by choosing a name and password. Accepting logs them in and opens that
tenant. A newer invitation to the same email replaces the pending one, and the
hourly sweep deletes expired ones.

Each user edits their own name and `phone_number` (`PATCH /api/auth/me`) and
changes their password with the current one (`POST /api/auth/me/password`),
which ends their other sessions. The `phone_number` is where their personal
alerts go.

## Platform operators

A platform operator is VendeYa staff. The flag is `users.is_platform_operator`,
not a role. An operator acts as `admin` in every tenant and may act across
tenants. Only an operator can create a tenant, add a member to any tenant,
register a channel account, look up a DNI and change platform settings. Only an
operator can reset another operator's password or deactivate them, whatever
tenants that operator belongs to. The same holds for their membership. A tenant
admin cannot change an operator's role in their tenant or remove them from it,
and gets 403. The operator's powers live on the account, but a tenant admin
could still lock VendeYa staff out of that one tenant. An ordinary member is a
tenant matter, even one with other memberships.

Operators are made only from the command line:

```sh
bun run account create <email> --platform-operator
bun run account promote <email>
```

`create --platform-operator` makes an account with no membership. `promote`
keeps the memberships the account already has. See
[Operations](./operations.md#accounts).

## Sessions and the business a request acts in

Logging in creates a 30-day session and sets the `session` cookie
([`platform/auth/session.ts`](../apps/backend/src/platform/auth/session.ts)). A
request with fewer than 15 days left renews the session for 30 more and sets the
cookie again, so a session lasts 30 days from the last request that renewed it.
Other responses send no cookie.

A browser request names the business it acts in with the `X-Tenant-Id` header:

```sh
curl -b "session=<token>" -H "X-Tenant-Id: <tenant id>" \
  https://sales.rising.sh/api/catalog/products
```

The dashboard keeps the business in the URL, `/dashboard/<tenant id>/…`, and
sends its id on every call from the page
([Dashboard](./dashboard.md#the-business-in-the-url)), so two tabs can work in
two businesses. A request that names no business acts in none, and a route that
needs one answers 403 `No active tenant`. A header naming a business the user is
not a member of, or a suspended one, answers 404 `Tenant not found`. A platform
operator may name any open business. No query parameter or body field names the
business a request acts in.

The session records `active_tenant_id`, the business its last request named.
`/api/auth/me` and `/api/tenants` report it as `lastTenantId`, and `/dashboard`
opens it. Logging in sets it to a member's only open business, and leaves it
empty for an operator or a member of several. It decides nothing about a later
request.

Every request re-reads the membership, so a changed role or a removed membership
takes effect on the next request. Changing a role ends no session.

## API tokens

An API token lets a script or an agent act as a person without their password
([`platform/auth/api-tokens.ts`](../apps/backend/src/platform/auth/api-tokens.ts)).
It is a session row of kind `token`, sent as `Authorization: Bearer vy_…`, and
it holds the same role and memberships as its owner. Only the SHA-256 of the
token is stored; the plain token appears once, in the answer that created it.

A token differs from a browser session in these ways:

- It lasts the 1 to 365 days it was created with (90 by default) and never
  renews itself.
- Created on the dashboard, it is bound to the business the page was in. It acts
  there whether or not a request names it, and a request naming another business
  answers 404. While that business is suspended, or its owner is no longer a
  member, it acts nowhere; it keeps its binding and works again when the
  business reopens.
- Created from the command line (`account token create`), it is bound to none
  and names its business on each request in `X-Tenant-Id`, as a browser does.
  `vendeya businesses use` stores that id for the CLI
  ([Operations](./operations.md#the-vendeya-command-line)).
- It cannot create another token or change the password. Those answer 403 and
  need a browser login.
- A bearer token is never accepted as a cookie, nor a cookie session as a
  bearer.

A person lists and revokes their tokens on a business's Cuenta page or with
`GET` and `DELETE /api/auth/tokens`. Changing the password ends every token.
Audit entries name the owner (`user:<id>`), not the token.

## How a read is scoped

`requireAuth` builds a scope for each request:
`{ userId, tenantId, membershipRole, isPlatformOperator }`
([`platform/auth/scope.ts`](../apps/backend/src/platform/auth/scope.ts)).

`tenantId` is the business the request acts in, or null when it names none. A
route on tenant data sits behind `requireTenantScope`, which refuses a null
`tenantId` with 403, operator or member. `activeTenantId(c)` in
[`middleware/auth.ts`](../apps/backend/src/middleware/auth.ts) gives a handler
the id, and throws the same 403 if a route forgot the gate.

Read functions take `tenantId: string` and filter with
`.where(tenantScope(tenantId))` from
[`db/index.ts`](../apps/backend/src/db/index.ts). A row fetched by id is looked
up in that tenant only, so another tenant's row answers 404, not 403. No route
reads one business's rows on behalf of another. The one read across businesses
is the platform summary, `GET /api/platform/summary`, which counts over open
tenants for operators.

The Kysely builder checks every query as it is built
([`db/tenant-scope.ts`](../apps/backend/src/db/tenant-scope.ts)). Each
tenant-owned table in a SELECT, UPDATE or DELETE, subqueries included, needs an
AND-ed `tenant_id` predicate. The predicate compares the column with a value or
a subquery, or with the `tenant_id` of a table already tied to a tenant. A
predicate inside an OR does not count. A query that fails the check throws
`UnscopedQueryError`. A read keyed by something globally unique before the
tenant is known, such as a session token, uses `withoutTenantScope(reason)`.

The minute sweep and the conversation objects read across tenants with
`inOpenTenants` and `inActiveChannelAccounts` from `db/index.ts`, so a suspended
business or a switched-off number is skipped.

## Channel accounts

A channel account is one WhatsApp business number, a row in `channel_accounts`
([`domains/channels/accounts.ts`](../apps/backend/src/domains/channels/accounts.ts)).
Its key is Meta's `phone_number_id`, unique across every tenant. Its status is:

| Status     | Receives | Sends | Set by                                                    |
| ---------- | -------- | ----- | --------------------------------------------------------- |
| `pending`  | no       | no    | the default; an account with no access token              |
| `active`   | yes      | yes   | storing an access token on a pending account, or an admin |
| `disabled` | no       | no    | an admin                                                  |

An account cannot be made `active` without an access token. Messages for a
non-active number are dropped at the webhook. Messages already queued for it
wait until it is active again.

A platform operator registers a number (`POST /api/admin/channels`). A tenant
admin lists their tenant's numbers and replaces a token or sets the status of
one (`PATCH /api/admin/channels/:id`). Both are API-only; the dashboard has no
page for them. How to get the values from Meta is in
[Connecting WhatsApp](./whatsapp.md).

When a tenant has several numbers and the caller names none (such as an alert),
the tenant's default is its oldest active account, then its oldest pending one.

## Encrypted credentials

An account's access token, webhook verify token and Meta app secret are stored
in `channel_secrets`, AES-256-GCM encrypted under `SECRETS_KEY`
([`platform/crypto/secrets.ts`](../apps/backend/src/platform/crypto/secrets.ts)).
The account row holds only a reference to each secret. Each ciphertext records a
`key_id`, the first 16 hex characters of the SHA-256 of the key, and a different
key cannot decrypt it.

`SECRETS_KEY` is 32 bytes, as 64 hex characters or as base64. It is read on
every use. Without it, no credential can be stored: the seed skips the channel
account, and the channels API answers 503. With the wrong key, stored tokens
cannot be read: sends fail with `no_token` while the account stays `active`.
There is no key rotation tool.

## The tenant's Cálidda login

Each business sells on its own Cálidda account, at the same API host as every
other business (`CALIDDA_BASE_URL`, a platform variable). A tenant admin enters
the login on the settings page: `calidda_username` is a plain tenant setting,
and `calidda_password` is encrypted in `tenant_secrets` under `SECRETS_KEY`, the
same scheme as `channel_secrets`
([`domains/settings/tenant-secrets.ts`](../apps/backend/src/domains/settings/tenant-secrets.ts)).
The API never returns the password: `GET /api/admin/settings` reports
`_has_calidda_password`, and posting a `calidda_password` value stores it
encrypted — an empty value clears it — while `POST /api/platform/settings`
refuses the key. A tenant with either part missing has no login, and its FNB
checks take the unavailable path. Saving a login drops the tenant's cached FNB
session and its breaker block. The login's FNB token cache in KV is keyed by
tenant.

## The tenant's OpenAI key

Each business brings its own OpenAI key. A tenant admin enters it on the
business's Ajustes page, `/dashboard/<tenant id>/admin/settings`, where it is
stored in `tenant_secrets` under the key `openai_api_key`, write-only like the
Cálidda password. There is no platform key: the turn builds the OpenAI client
from the tenant's stored key, and a tenant with none takes the same unavailable
path as an OpenAI outage. The dashboard's system status says the key is missing
while it is unset.

The save asks OpenAI for its model list with the new key. When OpenAI answers
401, the save fails with 400 (`reason: "invalid_openai_key"`) and writes none of
its settings. When OpenAI does not answer, the key is stored anyway, so an
outage never blocks a business.

## How a webhook reaches a tenant

Meta's payload names the receiving number in
`entry[].changes[].value.metadata.phone_number_id`.
[`routes/webhook.ts`](../apps/backend/src/routes/webhook.ts) looks the id up in
`channel_accounts`. The account names the tenant, and the number's own app
secret — stored in `channel_secrets` — is what the delivery's signature is
checked against. A batch that spans two tenants delivers to both, once the
signature has passed for every number it names.

## Suspension

Setting `tenants.status` to `suspended` closes a business:

- its browser sessions forget it as their last business, a request naming it
  answers 404, and a token bound to it acts nowhere,
- the webhook drops its messages,
- the conversation objects and the sweep skip its queued messages and outbox
  rows,
- its customers get no sends,
- the platform summary leaves it out.

Alerts about it still go out. Nothing in the dashboard or the API suspends a
tenant. It is a SQL update, run from `apps/backend`:

```sh
bunx wrangler d1 execute vendeya --remote \
  --command "UPDATE tenants SET status = 'suspended' WHERE id = '<tenant id>'"
```

Leave off `--remote` to change the local database. Setting the status back to
`active` reopens it.
