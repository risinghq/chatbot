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
// routes/dashboard/[tenantId=uuid]/catalog/+page.server.ts
export const load: PageServerLoad = async ({ cookies, fetch }) => {
  const sessionToken = cookies.get("session");
  // ...
  const res = await fetch("/api/catalog/products", {
    headers: { cookie: `session=${sessionToken}` },
  });
```

A load must use the `fetch` it is given. The global `fetch` cannot resolve a
relative `/api/...` URL on the server and throws. Most loads catch the error and
return empty data, so the page renders as if there were nothing to show.

## How auth state decides what renders

Sessions live on the backend. On every request,
[`hooks.server.ts`](../apps/frontend/src/hooks.server.ts) sends the `session`
cookie, and the business the URL names, to `GET /api/auth/me` and puts the
answer in `locals.user`. Its `role` is the role the user has in that business,
and null outside one. A request for any `/dashboard` path without a valid
session is redirected to `/login`.

On the client, the `auth` object in
[`lib/state/auth.svelte.ts`](../apps/frontend/src/lib/state/auth.svelte.ts)
holds the user, their role in the open business and the list of their
businesses. The root layout hydrates it from `locals.user`, so the server render
already shows the right role. Its getters (`isAdmin`, `canEditCatalog`,
`canAccessSimulator`, `canAccessProviders` and the rest) decide which tiles and
buttons show.

Role lists live in three places: the `auth` getters, the page guards, and the
backend's `requireRole`. Nothing keeps them equal. The backend's check is the
one that holds.

These pages check the role on the server:

- [`[tenantId]/admin/+layout.server.ts`](../apps/frontend/src/routes/dashboard/[tenantId=uuid]/admin/+layout.server.ts)
  sends anyone but `admin` to the business's home.
- `[tenantId]/reports/+page.server.ts` and
  `[tenantId]/historial/+page.server.ts` allow `admin`, `developer`,
  `supervisor`.
- `[tenantId]/asistente/probar/+page.server.ts` and
  `[tenantId]/asistente/registro/+page.server.ts` allow `admin`, `developer`.
- [`(platform)/+layout.server.ts`](<../apps/frontend/src/routes/dashboard/(platform)/+layout.server.ts>)
  allows platform operators only, and sends anyone else to `/dashboard`.

Other pages have no role guard. When the backend refuses their load with 403,
the load returns empty data.

## The business in the URL

Every page that shows a business's data lives under `/dashboard/<tenant id>/`.
The URL is the only place the dashboard keeps the open business, so two tabs can
work in two businesses, and a link names the business it points into.

- `hooks.server.ts` reads the session in the URL's business. A business that
  does not exist, is suspended or is not the user's sends them to `/dashboard`.
- Its `handleFetch` adds `X-Tenant-Id` to a server load's `/api/` calls, and
  `apiFetch` in [`lib/utils/api.ts`](../apps/frontend/src/lib/utils/api.ts) adds
  the business of the current page to a browser call. A load or a component
  never names the business itself.
- `/dashboard` holds no business. It opens the business the session last named,
  else a member's only business, else lists the businesses to pick from.
- `(platform)/` holds the pages of VendeYa's own staff, which belong to no
  business: Negocios, Reportes, Historial, Proveedores and Ajustes, with their
  own sidebar.
- `[...path]` catches a link from before the business was in the URL, such as
  `/dashboard/orders/42` in a WhatsApp alert, and opens it in the business last
  named.

`businessPath("/orders")` in
[`lib/state/business.svelte.ts`](../apps/frontend/src/lib/state/business.svelte.ts)
builds a link inside the open business. The switcher in
[`app-sidebar.svelte`](../apps/frontend/src/lib/components/shared/app-sidebar.svelte)
moves to the same section in another business with `samePageIn`.

## Route layout

```text
routes/
  +page.server.ts                   sends to /dashboard or /login
  login/                            sign-in form, prerendered
  dashboard/
    +page.server.ts                 opens a business, or lists them to pick
    +layout.svelte                  the shell, a drawer below md
    [...path]/                      an old link, opened in the last business
    (platform)/                     platform operators only, no business
      negocios/                     businesses: create, open
      reports/                      reports across businesses
      historial/                    what changed outside any business
      providers/                    DNI lookup and provider checks
      ajustes/                      Power BI and the provider switches
    [tenantId=uuid]/                one business, named by the URL
      +page.svelte                  home: setup checklist and warnings
      conversations/  [phone]/      inbox and one conversation
      asistente/                    the assistant's instructions, model and tools
        probar/                     the simulator: admin, developer
        registro/                   the assistant's model calls: admin, developer
      clientes/  [customerId]/      customers and one customer
      catalog/  inventory/[id]/     products; one product and its variants
      inventario/                   stock per variant and the movement ledger
      orders/  [orderId]/
      envios/                       delivery zones and shipments
      reports/                      admin, developer, supervisor
      historial/                    what the team changed: admin, developer, supervisor
      cuenta/                       the signed-in user's account
      admin/                        admin only
        users/  [userId]/  create/
        channels/  orders/  settings/
```

## Adding a page

A page under `dashboard/[tenantId=uuid]/` needs three things:

1. **A route.** `routes/dashboard/[tenantId=uuid]/<area>/+page.svelte`, and a
   `+page.server.ts` if it loads data on the server. If only some roles may see
   it, check `locals.user.role` there and
   ``redirect(303, `/dashboard/${params.tenantId}`)``.
2. **A sidebar entry.** A `NavItem` in
   [`app-sidebar.svelte`](../apps/frontend/src/lib/components/shared/app-sidebar.svelte)
   with `href: businessPath("/<area>")`, pushed under the `auth` getter for a
   restricted page. Without it nothing links to the page. A page under `admin/`
   gets a tab in the admin layout instead. A platform page goes under
   `(platform)/` and in
   [`platform-sidebar.svelte`](../apps/frontend/src/lib/components/shared/platform-sidebar.svelte).
3. **A title.** `<PageTitle title="..." />` sets the tab title, and
   `<PageHeader>` draws the visible heading inside the page container that
   [docs/design.md](./design.md) describes.

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
  `S/ {formatPrice(x)}`. A variant's price and cost arrive in cents: show them
  with `formatCents` and read typed amounts with `parseCents`, both in
  [`lib/utils/money.ts`](../apps/frontend/src/lib/utils/money.ts).
- Styling is Tailwind v4 utility classes on the tokens in
  [`lib/styles/tokens.css`](../apps/frontend/src/lib/styles/tokens.css).
  [docs/design.md](./design.md) owns the visual rules.
- Shared UI pieces are in
  [`lib/components/ui/`](../apps/frontend/src/lib/components/ui/).

## The Proveedores page

The page calls `GET /api/providers/:dni` and shows the `result` in the answer.
`result` is the `CreditCheck` from `@vendeya/types`: a `status` (`eligible`,
`not_eligible` or `system_outage`) and, for an approval, the `source` that
approved (`fnb` or `powerbi`), `credit`, `name` and `nse`. Only an approval
carries a credit line. When the check itself failed, `result` is `{ error }`.

The two dots in the page header come from `providersChecked` in the same answer:
the providers whose circuit breaker was closed for that lookup. They appear
after the first lookup. The page does not read `/api/health`.

## Products, variants and stock

A product is what the business sells: name, description, category, brand, model,
specs and a status (`draft`, `active` or `archived`). A variant is the sellable
unit: its own SKU, `price_cents` and optional `cost_cents`. A product sold in
one form has one variant with no name. A SKU is unique inside a business, and a
second use answers 409.

| Endpoint                                         | Does                                                      |
| ------------------------------------------------ | --------------------------------------------------------- |
| `GET`, `POST /api/catalog/products/:id/variants` | A product's variants; add one (201)                       |
| `PATCH /api/catalog/variants/:id`                | Change name, SKU, price, cost or `is_active`              |
| `GET /api/stock[?location_id=]`                  | On hand, reserved and available per variant               |
| `GET`, `POST /api/stock/locations`               | Where stock is kept; a duplicate name is 409              |
| `GET /api/stock/movements[?variant_id=&limit=]`  | The ledger, newest first                                  |
| `POST /api/stock/movements`                      | Record `{variant_id, location_id?, kind, quantity, note}` |

Stock changes only through a movement. Each movement and its level change are
one `batch()`, and the table's CHECK keeps on hand and reserved at zero or more,
with reserved never above on hand. A movement that would break that answers 409
and writes nothing. The kinds:

- `receive` adds a positive quantity to on hand.
- `adjust` adds a signed quantity to on hand, after a count.
- `reserve` and `release` move a positive quantity into and out of reserved.
- `ship` takes a positive quantity out of both on hand and reserved.

A business with no location gets "Almacén principal" on its first movement. With
one location, a movement may leave out `location_id`. With several, it must name
one, or the API answers 400. Reading stock is open to every role in the
business. Writing variants, locations and movements needs admin, developer or
supervisor.

The Inventario page records only `receive` and `adjust`. Orders reserve, release
and ship on their own; [Orders](#orders) says when.

### Importing a catalog

The Catálogo page's «Importar desde Excel» reads an xlsx, xls or CSV file with
one row per variant, up to 500 rows and 2 MB. The first row names the columns.
Producto and Precio are required; Categoría, SKU, Costo, Stock, Marca, Modelo,
Descripción and Variante are optional, and the headers in
`apps/backend/src/domains/catalog/import.ts` list the other spellings each one
accepts. Columns such as Talla, Color, Medida or Presentación are joined into
the variant name, "M / Rojo". Money may be written 49.90, 49,90 or S/ 1,299.00.
The dialog's template is a CSV with the columns for the business's kind.

| Endpoint                           | Does                                                           |
| ---------------------------------- | -------------------------------------------------------------- |
| `POST /api/catalog/import/preview` | Multipart `file`; what each row would do, its errors, and more |
| `POST /api/catalog/import`         | Multipart `file` and `location_id?`; writes the file (201)     |

A row whose SKU exists updates that variant's price, and its cost when the row
gives one. A row without a SKU updates the variant of the same product and
name, so importing a file twice changes nothing. Any other row is a new
variant. Stock is only set on new variants, as a `receive` movement; an
existing variant's stock moves through Inventario. The whole file is one
`batch()`: a row with an error answers 400 with every error and writes nothing.
With stock and several locations, the import must name `location_id`; the
preview lists the locations when it must. Importing needs admin, developer or
supervisor.

## Orders

An order belongs to a customer, a business-scoped record keyed by phone. Its
lines name a variant, or are free lines with a name, SKU and price but no stock.
Numbers start at 1001 in each business. Amounts are integer cents.

The statuses and their moves are `ORDER_TRANSITIONS` in
[`packages/types/src/orders.ts`](../packages/types/src/orders.ts):

```text
pending ─▶ confirmed ─▶ packed ─▶ shipped ─▶ delivered
   │           │           └──────────────────▲  (pickup)
   └───────────┴───────────┴──▶ cancelled
```

Stock follows the status. Creating an order reserves its variant lines.
`shipped`, or `delivered` straight from `packed` for a pickup, ships them.
Cancelling before `shipped` releases them. A move that short stock or the
transition table forbids answers 409 and writes nothing.

A payment is recorded as `pending` and counts toward the balance only once
confirmed. A shipment is optional: an order with a delivery zone carries the
zone's fee and an address; an order without one is a pickup. Who may do what is
in [Tenancy](./tenancy.md).

| Endpoint                                                        | Does                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/orders[?status=&startDate=&endDate=]`                 | Summaries with customer, total, paid and payment state   |
| `GET /api/orders/metrics`                                       | Count per status, outstanding and delivered cents        |
| `GET /api/orders/:id`                                           | Customer, lines, payments, shipment                      |
| `POST /api/orders`                                              | Create from a customer id or `{phone, name}`, with lines |
| `POST /api/orders/:id/transition`                               | Move to `{status}`                                       |
| `POST /api/orders/:id/payments`                                 | Record a payment                                         |
| `POST /api/orders/:id/payments/:paymentId/confirm`              | Confirm it; `/reject` rejects it                         |
| `PATCH /api/orders/:id/shipment`                                | Change the address, carrier or tracking                  |
| `/api/customers`, `/api/delivery-zones`, `/api/payment-methods` | List, create, update and delete                          |

The Pedidos page lists orders with these filters. One order's page shows its
lines, shipment and payments, and offers the next moves the caller's role
allows.

### Product photos

A product holds up to 10 photos in order, and the first is its cover. The
product list returns the cover as `cover_url`, and the Productos grid shows it
next to the name. The product editor's Fotos section uploads, deletes and picks
the cover.

| Endpoint                                     | Does                                                         |
| -------------------------------------------- | ------------------------------------------------------------ |
| `GET /api/catalog/products/:id/images`       | The photos in order, each with its public `url`              |
| `POST /api/catalog/products/:id/images`      | Upload the multipart field `image`; it goes last             |
| `PUT /api/catalog/products/:id/images/order` | `{ids}` naming every photo once; the first becomes the cover |
| `DELETE /api/catalog/images/:id`             | Delete the photo, its asset row and its file                 |

An upload is fit inside 1024 × 1024 and stored as JPEG, and is served without a
session at `/media/...` because Meta fetches it with no credentials. Over 10 MB
answers 413, an eleventh photo 409, and a file the Images binding cannot
read 400. There is no upload from a URL, so the server never fetches an address
a user chose. Writing needs admin, developer or supervisor.

## What has no page

The API has endpoints the dashboard does not reach: registering channel accounts
and the operator's DNI lookup. [Tenancy](./tenancy.md),
[Connecting WhatsApp](./whatsapp.md) and [Eligibility](./eligibility.md) show
the ones an operator needs as `curl` commands.

## Onboarding a business

`/dashboard/negocios` is the platform operator's business page: the tenant list,
a form that posts `POST /api/tenants` with a name, and an Entrar link per
business that opens `/dashboard/<tenant id>`. People join a business by
invitation from its Usuarios page (`/dashboard/<tenant id>/admin/users`):
`POST /api/admin/invitations` with `{ email, role }` answers a link the admin
copies and sends. The link opens `/invitacion/<token>`. A business owner who is
not VendeYa staff starts at `/registro`, which opens the business and logs them
in as its admin. Each user's own profile, password and API tokens are on the
Cuenta page of a business they belong to (`/dashboard/<tenant id>/cuenta`).

While a business is unfinished, the home page and the Negocios page show a setup
checklist (`lib/components/shared/setup-checklist.svelte`) fed by
`GET /api/admin/setup-status`. Its steps run in the order a new business takes
them: the OpenAI key, an active product with an active variant, units of such a
variant that are not reserved, an active payment method, one conversation in the
simulator, and a WhatsApp number with its token and app secret. The first
pending step carries the primary action. The checklist hides once every step is
done. A team and the Cálidda login are optional: the footer points to them, but
they do not hold the checklist open. The owner who signed up is already a
member.

Pages that work inside one business show a pick-a-business message
(`lib/components/shared/needs-tenant.svelte`) when the session has no active
tenant, instead of an empty table or an error.
