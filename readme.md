# VendeYa

VendeYa sells on WhatsApp for an online shop. Its assistant answers each
customer with the catalog's real prices, stock and photos. It takes the order,
reserves the stock and sends a pay link. Staff can step into any chat. It is
built for shops with set prices: clothing, accessories, perfume, electronics,
pets. A shop that sells services or quotes uses it for the first reply and
closes the sale itself.

A shop signs up at <https://sales.rising.sh>. This repository is the whole
service: the WhatsApp assistant, the dashboard and the `vendeya` CLI.

## Run it locally

With [mise](https://mise.jdx.dev) installed:

```sh
mise install
bun install --frozen-lockfile
cp apps/backend/.dev.vars.example apps/backend/.dev.vars
bun run db:migrate && bun run seed
bun run account create admin@example.com
bun run dev
```

`account create` asks for a password. Open <http://localhost:5173> and log in as
`admin@example.com`. Paste an OpenAI key in Administración › Configuración. Then
open Asistente › Probar and ask for a product from the demo catalog:

```text
Cliente:   ¿tienen el Samsung Galaxy A35?
Asistente: Sí, el Samsung Galaxy A35 está a S/ 2,199.00 y tenemos 10 en stock.
           ¿Te lo separo?
```

The simulator needs no WhatsApp number. [Get started](./docs/get-started.md)
covers the setup step by step.

## Features

- An assistant that answers from the catalog: price, stock per variant and the
  photos of the variant asked for. The shop shapes it with instructions.
- Orders that reserve stock when taken and ship it when sent, with delivery
  zones and fees.
- TAYPI pay links (Yape, Plin and cards) that record the payment on the order.
- Takeover: a person answers a chat and hands it back.
- A catalog shaped by what the shop sells: sizes and colours for clothing, brand
  and model for electronics, and a grid that creates every variant at once.
- Catalog import from an Excel or CSV sheet, with a preview before anything is
  saved.
- Stock per warehouse, customers, staff roles and sales reports.
- An optional Cálidda credit check for appliance shops.
- The `vendeya` CLI, which drives a business from a shell or an AI agent with an
  API token.

## Documentation

- The [manual](./docs/readme.md) covers setup, conversations, the dashboard,
  WhatsApp, deploy and operations.
- [Contributing](./.github/contributing.md) covers checks and pull requests.
