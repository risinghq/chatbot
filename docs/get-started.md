# Get started

This takes a fresh clone to a bot you can talk to in the dashboard's simulator.
It needs no Cloudflare account, no WhatsApp number, no Cálidda credentials and
no LLM key.

## Prerequisites

- [mise](https://mise.jdx.dev), which installs the pinned Bun and Node from
  [`mise.toml`](../mise.toml). Bun and Node of those versions on your `PATH`
  work too. Wrangler, the Cloudflare CLI, runs on Node.

## Install

```sh
git clone https://github.com/totallynotdavid/chatbot.git
cd chatbot
mise install
bun install --frozen-lockfile
```

## The local secrets

```sh
cp apps/backend/.dev.vars.example apps/backend/.dev.vars
```

`wrangler dev`, the seed and the account command read `apps/backend/.dev.vars`.
Its values override the production values in `apps/backend/wrangler.jsonc`. For
the simulator, the defaults are enough.

Set `SECRETS_KEY` now. It encrypts each WhatsApp number's access token:

```sh
bun scripts/generate-token.ts secrets
```

prints a line such as `SECRETS_KEY="IiGTB0N-..."`. Put it in
`apps/backend/.dev.vars`.

Without `SECRETS_KEY`, no credential can be stored. The seed skips the channel
account and says so, the account command refuses to create one, and nothing can
be sent to WhatsApp. The simulator still works: it talks on the business's
simulator channel, which needs no credential. A different key later cannot read
the tokens stored under this one.

## The database

The database is a local D1 database. Wrangler keeps it, with the local KV and R2
stores, under `apps/backend/.wrangler/state`. Create the tables:

```sh
bun run db:migrate
```

It applies the migrations in `apps/backend/migrations` that have not run, and
does nothing when there are none. Run it again after pulling a change that adds
a migration.

`bun run --cwd apps/backend clean` deletes the local state. Run `db:migrate` and
the seed again after it.

## The seed

```sh
bun run seed
```

creates a demo business, "Tienda demo", in the local D1 with a sample catalog
and a few test conversations, and uploads the catalog images to the local R2.
The conversations hang off a `pending` placeholder number, which needs
`SECRETS_KEY` in `.dev.vars`. It prints the business's id.

Each run creates a new demo business. `bun run seed -- --tenant <id>` loads the
demo into an existing one instead. The seed only writes the local database: a
real business starts at signup and owns everything it sells.

## The first account

The seed creates no user. Create an admin of the demo business:

```sh
bun run account create admin@example.com --tenant <id>
```

The `--tenant` flag can be left out while the database has one business. Signing
up at <http://localhost:5173/registro> also works: it opens a new, empty
business with you as its admin.

It asks for a password twice, at least 12 characters. To also act across
tenants, create a platform operator:

```sh
bun run account create ops@example.com --platform-operator
```

[Operations](./operations.md#accounts) has every form of the command.

## Run it

```sh
bun run dev
```

starts two servers, which reload on change:

| Server    | Address                 | Role                                                         |
| --------- | ----------------------- | ------------------------------------------------------------ |
| backend   | `http://localhost:8787` | `wrangler dev`: the webhook, the API, the Durable Objects    |
| dashboard | `http://localhost:5173` | `vite dev`: the dashboard, which sends `/api` to the backend |

The dashboard reaches the backend through its `BACKEND` service binding, as in
production. `bun run dev:backend` and `dev:frontend` start one at a time.

`wrangler dev` does not run the cron trigger on its own. To run the sweep that
production runs every minute:

```sh
curl http://localhost:8787/cdn-cgi/local/scheduled
```

## Talk to the bot

1. Open <http://localhost:5173> and log in as `admin@example.com`.
2. Open Asistente, then the Probar tab.
3. Start a new simulation ("Nueva simulación").
4. Write `hola`, then ask for a product, such as `¿tienen celulares?`.

The assistant answers from the demo catalog. It searches the products and sends
their photos. The wording varies between runs.

The same conversation through the API, with both servers running:

```sh
curl -c cookies.txt -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"<password>"}' \
  http://localhost:5173/api/auth/login
phone=$(curl -s -b cookies.txt -X POST \
  http://localhost:5173/api/simulator/conversations |
  sed -E 's/.*"phone_number":"([0-9]+)".*/\1/')
for m in hola '¿tienen celulares?'; do
  curl -b cookies.txt -H 'content-type: application/json' \
    -d "{\"phoneNumber\":\"$phone\",\"message\":\"$m\"}" \
    http://localhost:5173/api/simulator/message
done
curl -b cookies.txt http://localhost:5173/api/simulator/conversation/$phone
```

The server chooses the new conversation's phone number and returns it in
`phone_number`. It takes one past the highest simulated number (`519` and eight
digits) on the tenant's simulator channel, starting at `51900000001`. It skips
`51999999999`, which the replay of a real conversation uses. The simulator
channel is apart from the business's WhatsApp numbers, so a simulated number
never meets a real customer's thread. A deleted conversation never frees a
number another simulation holds.

Without an OpenAI key, the simulator answers 409 with
`{"reason":"no_openai_key"}` and the page asks for the key. Each tenant brings
its own key: the admin enters it on `/dashboard/admin/settings`, under OpenAI. A
turn that fails after that answers 500 with `{"status":"failed","error":"..."}`.

The `vendeya` command line drives the same routes: `simulate start`, then
`simulate say <phone> <message>` prints the assistant's replies
([Operations](./operations.md#the-vendeya-command-line)).

## Next

- [How a conversation runs](./conversation.md) explains what just happened.
- [Connecting WhatsApp](./whatsapp.md) connects a real number.
- [Deploy](./deploy.md) puts it on Cloudflare.
- [Development](./development.md) lists the checks to run before a change.
