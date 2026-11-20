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

A new tenant has no catalog, no periods and no channel account. A platform
operator creates one from `/dashboard/negocios` in the dashboard
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

| Role          | Adds                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| `admin`       | `/api/admin/*`: users, channel accounts, settings, audit                  |
| `developer`   | catalog and period writes, reports, analytics, system logs, the simulator |
| `supervisor`  | catalog and period writes, reports, analytics, system logs                |
| `sales_agent` | nothing beyond the base                                                   |

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
Order status changes allowed per role are in
[`routes/orders.ts`](../apps/backend/src/routes/orders.ts). Role checks are
`requireRole` in [`middleware/auth.ts`](../apps/backend/src/middleware/auth.ts)
and the route files.

Authorization reads the membership role; a user has no role of their own. A user
can belong to several tenants with a different role in each. Availability for
new conversations (`is_available`) is also per membership.

A user logs in with their email, stored trimmed and lower-case and unique across
the deployment. A tenant admin brings people in by invitation
(`POST /api/admin/invitations` with `{ email, role }`). The answer carries a
link, `/invitacion/<token>`, shown once for the admin to send. Only the token's
hash is stored, and the link lasts seven days. Whoever opens it joins the tenant
with the invited role: an existing account by entering its password, a new
person by choosing a name and password. Accepting logs them in, pinned to that
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

## Sessions and the active tenant

Logging in creates a 30-day session and sets the `session` cookie
([`platform/auth/session.ts`](../apps/backend/src/platform/auth/session.ts)). A
request with fewer than 15 days left renews the session for 30 more and sets the
cookie again, so a session lasts 30 days from the last request that renewed it.
Other responses send no cookie. The session carries `active_tenant_id`, the
tenant it acts in. A member of exactly one open tenant starts pinned to it. An
operator, and a member of several, starts unpinned and picks one:

```sh
curl -X POST -b "session=<token>" -H 'content-type: application/json' \
  -d '{"tenantId":"<id>"}' https://sales.rising.sh/api/tenants/active
```

The dashboard does this from the tenant selector. The active tenant is the only
tenant input. No header or query parameter names a tenant.

Every request re-reads the membership, so a changed role or a removed membership
takes effect on the next request. Changing a role ends no session.

## How a read is scoped

`requireAuth` builds a scope for each request:
`{ userId, tenantId, membershipRole, isPlatformOperator }`
([`platform/auth/scope.ts`](../apps/backend/src/platform/auth/scope.ts)).

- A pinned caller reads only their tenant.
- An unpinned operator reads across every `active` tenant.
- An unpinned member is refused with 403 by `requireTenantScope`.
- A write needs a concrete tenant. `requireActiveTenant` refuses an unpinned
  caller, operator included.

An unpinned member reads nothing until selecting a tenant.

Read functions take `tenantId: string | null` and filter with
`tenantPredicate(tenantId)` from
[`db/query.ts`](../apps/backend/src/db/query.ts). A concrete id filters to that
tenant. `null` means every open tenant, never every row. A row fetched by id is
checked with `canAccessTenant`, and another tenant's row answers 404, not 403.

The minute sweep and the conversation objects read across tenants with
`openTenantsOnly()` and `activeChannelAccountsOnly()`, so a suspended business
or a switched-off number is skipped.

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

When a tenant has several numbers and the caller names none (the simulator, an
alert), the tenant's default is its oldest active account, then its oldest
pending one.

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
encrypted — an empty value clears it — while a platform-scoped post refuses the
key. A tenant with either part missing has no login, and its FNB checks take the
unavailable path. Saving a login drops the tenant's cached FNB session and its
breaker block. The login's FNB token cache in KV is keyed by tenant.

## The tenant's OpenAI key

Each business brings its own OpenAI key. A tenant admin enters it on
`/dashboard/admin/settings`, where it is stored in `tenant_secrets` under the
key `openai_api_key`, write-only like the Cálidda password. There is no platform
key: the turn builds the OpenAI client from the tenant's stored key, and a
tenant with none takes the same unavailable path as an OpenAI outage. The
dashboard's system status says the key is missing while it is unset.

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

- its sessions lose their pin, and its members cannot pin it,
- the webhook drops its messages,
- the conversation objects and the sweep skip its queued messages and outbox
  rows,
- its customers get no sends,
- an operator's cross-tenant reads leave it out.

Alerts about it still go out. Nothing in the dashboard or the API suspends a
tenant. It is a SQL update, run from `apps/backend`:

```sh
bunx wrangler d1 execute vendeya --remote \
  --command "UPDATE tenants SET status = 'suspended' WHERE id = '<tenant id>'"
```

Leave off `--remote` to change the local database. Setting the status back to
`active` reopens it.
