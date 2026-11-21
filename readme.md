# VendeYa

VendeYa is a managed WhatsApp sales service for businesses in Lima. A customer
writes to the business's WhatsApp number, the bot checks credit eligibility and
shows catalog items, and the business's sales team takes over to close the sale.

The current flow is shared by every tenant and is built for appliances sold on
Cálidda credit. VendeYa staff create and operate each tenant. The bot handles
text messages and catalog images. It does not take payment, arrange delivery, or
process inbound images, audio, or other non-text messages.

VendeYa runs on Cloudflare Workers. Local development runs the same Workers
under `wrangler dev`, with local D1, KV and R2, and needs no Cloudflare account.

## Install

The local setup needs [mise](https://mise.jdx.dev), which installs Bun and Node.
From a fresh clone:

```sh
mise install
bun install --frozen-lockfile
cp apps/backend/.dev.vars.example apps/backend/.dev.vars
bun run db:migrate
bun run seed
bun run account create admin
bun run dev
```

`account create` asks for the new user's password.

Open <http://localhost:5173>, log in as `admin`, and open the Simulador. Start a
simulation with the persona `FNB - Crédito Alto (S/ 8000)`, then send `hola`,
`si`, and an eight-digit DNI such as `12345678`. The simulator needs no WhatsApp
number, provider credentials, or LLM key. The full setup and real number
instructions are in [Get started](./docs/get-started.md).

## Features

- An optional Cálidda credit check backed by the FNB and GASO providers.
- Tenant-specific catalogs, stock, conversations, orders, and staff roles.
- New tenants and their WhatsApp numbers are added with the `account` CLI,
  without a deploy.
- A dashboard for conversations, catalog and order work, reports, and a provider
  lookup for platform operators.
- A simulator with built-in personas for testing the conversation flow.
- WhatsApp Cloud API sends.
- An outbox that retries recoverable send failures and hands undeliverable
  replies to a person.

## Read next

- The [manual](./docs/readme.md) is the ordered guide for setup, deploy,
  operations, WhatsApp, tenancy, and development.
- [Architecture](./docs/architecture.md) maps the Workers, request flow, state,
  and code ownership.
- [Contributing](./.github/contributing.md) is the contributor entry point.
