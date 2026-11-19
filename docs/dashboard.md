# The dashboard

The dashboard is the SvelteKit app in [`apps/frontend`](../apps/frontend/). A
business's staff use it to work conversations, edit the catalog and follow
orders. Its UI text is Spanish.

## How it reaches the backend

The dashboard is its own Worker, `vendeya-dashboard`, on the same host as the
backend. In production the browser's requests to `/api/*` and `/media/*` go
straight to the backend Worker, whose routes take those paths before the
dashboard sees them.

The dashboard's server reaches the backend through its `BACKEND` service
binding, a call between Workers that never leaves Cloudflare.
[`hooks.server.ts`](../apps/frontend/src/hooks.server.ts) does two things with
it:

- It passes any request for `/api/*` or `/media/*` that reaches the dashboard to
  the backend unchanged, body and headers included. A server load's `fetch` of
  `/api/...` takes this path, and so does every browser request under
  `bun run dev`.
- For every page, it asks the backend's `/api/auth/me` who the `session` cookie
  belongs to, and sends a visitor with no user from `/dashboard/*` to `/login`.

`/login` is prerendered and served from Workers assets, with no server code.

Components call the API with `fetchApi` from
[`lib/utils/api.ts`](../apps/frontend/src/lib/utils/api.ts), a thin `fetch`
wrapper that throws `ApiError` with the backend's `error` text on a non-2xx.
Server loads use SvelteKit's `fetch` and copy the `session` cookie into the
request by hand:

```ts
// routes/dashboard/catalog/+page.server.ts
export const load: PageServerLoad = async ({ cookies, url, fetch }) => {
  const sessionToken = cookies.get("session");
  // ...
  const headers = { cookie: `session=${sessionToken}` };
  const periodsRes = await fetch("/api/periods", { headers });
```

A load must use the `fetch` it is given. The global `fetch` cannot resolve a
relative `/api/...` URL on the server and throws. Most loads catch the error and
return empty data, so the page renders as if there were nothing to show.

## How auth state decides what renders

Sessions live on the backend. On every request,
[`hooks.server.ts`](../apps/frontend/src/hooks.server.ts) sends the `session`
cookie to `GET /api/auth/me` and puts the answer in `locals.user`. A request for
any `/dashboard` path without a valid session is redirected to `/login`.

On the client, the `auth` object in
[`lib/state/auth.svelte.ts`](../apps/frontend/src/lib/state/auth.svelte.ts)
holds the user, their role, the active tenant and the tenant list. The root
layout fills it in `onMount`, so the server renders every page as signed out and
role-dependent parts appear after hydration. Its getters (`isAdmin`,
`canEditCatalog`, `canAccessSimulator`, `canAccessProviders` and the rest)
decide which tiles and buttons show.

Role lists live in three places: the `auth` getters, the page guards, and the
backend's `requireRole`. Nothing keeps them equal. The backend's check is the
one that holds.

These pages check the role on the server:

- [`dashboard/admin/+layout.server.ts`](../apps/frontend/src/routes/dashboard/admin/+layout.server.ts)
  sends anyone but `admin` to `/dashboard`.
- `reports/+page.server.ts` allows `admin`, `developer`, `supervisor`.
- `simulator/+page.server.ts` and `personas/+page.server.ts` allow `admin`,
  `developer`.
- `negocios/+page.server.ts` allows platform operators only.

Other pages have no role guard. When the backend refuses their load with 403,
the load returns empty data.

The tenant selector sits in
[`dashboard-nav.svelte`](../apps/frontend/src/lib/components/shared/dashboard-nav.svelte).
It calls `POST /api/tenants/active` and reloads the page. The nav bar, and so
the selector, is not shown on `/dashboard` itself.

## Route layout

```text
routes/
  +page.server.ts                   sends to /dashboard or /login
  login/                            sign-in form, prerendered
  dashboard/
    +page.svelte                    home: a grid of tiles
    +layout.svelte                  nav bar and breadcrumbs, except on home
    conversations/  [phone]/        inbox and one conversation
    catalog/  bundles/[id]/  inventory/[id]/
    orders/  [orderId]/
    reports/                        admin, developer, supervisor
    activity/                       system activity
    simulator/                      admin, developer
    personas/  create/              admin, developer
    providers/                      DNI lookup, platform operators
    negocios/                       business management, platform operators
    admin/                          admin only
      users/  [userId]/  create/
      periods/  audit/  settings/
```

## Adding a page

A page under `dashboard/` needs four things:

1. **A route.** `routes/dashboard/<area>/+page.svelte`, and a `+page.server.ts`
   if it loads data on the server. If only some roles may see it, check
   `locals.user.role` there and `redirect(303, "/dashboard")`.
2. **A tile.** A `DashboardGridItem` in
   [`dashboard/+page.svelte`](../apps/frontend/src/routes/dashboard/+page.svelte),
   wrapped in `{#if auth.<getter>}` for a restricted page. Without it nothing
   links to the page.
3. **A nav label.** An entry in `breadcrumbLabels` in
   [`dashboard-nav.svelte`](../apps/frontend/src/lib/components/shared/dashboard-nav.svelte).
   Without it the page gets no breadcrumb.
4. **A title.** `<PageTitle title="..." />` from
   [`page-title.svelte`](../apps/frontend/src/lib/components/shared/page-title.svelte).

The backend route it calls needs its own `requireRole`. The page guard only
hides the page.

Conventions the pages follow:

- Svelte 5 runes: `$props()` with a `Props` type, `$state`, `$derived`, callback
  props, snippets.
- Mutations are client-side `fetchApi` calls with feedback through `toast` from
  [`lib/state/toast.svelte.ts`](../apps/frontend/src/lib/state/toast.svelte.ts).
  No page uses form actions.
- Dates and money go through
  [`lib/utils/formatters.ts`](../apps/frontend/src/lib/utils/formatters.ts),
  which formats for `es-PE` in `America/Lima`. Prices are written
  `S/ {formatPrice(x)}`.
- Styling is Tailwind v4 utility classes, with colour tokens in
  [`lib/styles/tokens.css`](../apps/frontend/src/lib/styles/tokens.css).
- Shared UI pieces are in
  [`lib/components/ui/`](../apps/frontend/src/lib/components/ui/).

## The Proveedores page

The page calls `GET /api/providers/:dni` and shows the `result` in the answer.
`result` is what
[`mapper.ts`](../apps/backend/src/domains/eligibility/mapper.ts) builds: a
`status` (`eligible`, `not_eligible`, `system_outage` or `needs_human`) and, for
an approval, `segment`, `credit`, `name` and `nse`. Only an approval carries a
credit line. When the check itself failed, `result` is `{ error }`. The answer
does not say which provider replied, so the page shows the segment.

The two dots in the page header come from `providersChecked` in the same answer:
the providers whose circuit breaker was closed for that lookup. They appear
after the first lookup. The page does not read `/api/health`.

## Editing the catalog

The bundle editor saves with `PATCH /api/catalog/bundles/:id`, and the stock
badge on a bundle card sends `stock_status` to the same route. The route stores
`name`, `price`, `is_active`, `stock_status`, `notes`, `primary_category`,
`composition_json` and `installments_json`, and ignores any other key.

The request body must be a JSON object. `name` and the category must be
non-empty strings. `price` must be a number above zero, `is_active` 0 or 1, and
`stock_status` one of `in_stock`, `low_stock` and `out_of_stock`. `notes` must
be a string. Each JSON column must be a string that parses to an object or an
array. The bot parses both on every catalog read. The create route holds `name`,
`price`, the category and the JSON columns to the same rules, and
`POST /api/catalog/bundles/bulk-update` holds `is_active` and `stock_status` to
them, and answers 400 when `ids` is empty or `updates` is not an object that
sets one of the two. A value that fails answers 400 and changes nothing.

## What has no page

The API has endpoints the dashboard does not reach: registering channel
accounts, retrying eligibility, the analytics endpoints.
[Tenancy](./tenancy.md), [Connecting WhatsApp](./whatsapp.md) and
[Eligibility](./eligibility.md) show the ones an operator needs as `curl`
commands.

## Onboarding a business

`/dashboard/negocios` is the platform operator's business page: the tenant list,
a form that posts `POST /api/tenants`, an Entrar button per business that pins
the session through `POST /api/tenants/active`, and a member form for the active
business — `POST /api/admin/users` to create the account, or
`POST /api/tenants/:id/members` with `{ username, role }` for a user that
already exists.

While a business is unfinished, the home page and the Negocios page show a setup
checklist (`lib/components/shared/setup-checklist.svelte`) fed by
`GET /api/admin/setup-status`: the OpenAI key, a WhatsApp number with its token
and app secret, the Cálidda login, and at least one member. It hides once every
step is done.

Pages that work inside one business show a pick-a-business message
(`lib/components/shared/needs-tenant.svelte`) when the session has no active
tenant, instead of an empty table or an error.
