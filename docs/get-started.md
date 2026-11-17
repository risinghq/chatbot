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

Without `SECRETS_KEY`, no access token can be stored. The seed leaves the
default number `pending`, the account command refuses a token, and nothing can
be sent to WhatsApp. The simulator still works, because it sends nothing. A
different key later cannot read the tokens stored under this one.

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

writes the default tenant `totem`, a sample catalog, and a few test
conversations to the local D1, and uploads the catalog images to the local R2.
With no `WHATSAPP_PHONE_ID` in `.dev.vars`, the tenant's number is a `pending`
placeholder. The seed is safe to run again.

## The first account

The seed creates no user. Create an admin of `totem`:

```sh
bun run account create admin
```

It asks for a password twice, at least 12 characters. To also act across
tenants, create a platform operator:

```sh
bun run account create ops --platform-operator
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

1. Open <http://localhost:5173> and log in as `admin`.
2. Open the Simulador tile.
3. Start a new simulation ("Nueva simulación") and pick the persona "FNB -
   Crédito Alto (S/ 8000)". A persona answers the eligibility check in place of
   Cálidda.
4. Write `hola`, then `si`, then any DNI such as `12345678`.

The bot greets you as Cálidda, asks whether the gas service is in your name,
asks for your DNI, then offers S/ 8000 of credit and lists the product groups:

```text
hola      -> ¡Qué tal! Somos Cálidda. ¿Tu servicio de gas está a tu nombre?
si        -> Genial 😊, ¿me brindas el número de tu DNI?
12345678  -> ¡Excelente noticia, Maria! 🎉 Tienes una línea de crédito aprobada de S/ 8000.00.
             ¿Qué estás buscando? Tengo productos de Línea blanca y hogar, Tecnología, Combos.
```

The wording varies between runs. Answer with a group, such as `Tecnología`, then
a category it lists, such as `celulares`, to get up to three products as images.

For each simulated message the backend logs "Refusing to send on a channel
account that is not active". It comes from marking the message read on the
`pending` placeholder number, and changes nothing.

The same conversation through the API, with both servers running:

```sh
curl -c cookies.txt -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<password>"}' \
  http://localhost:5173/api/auth/login
phone=$(curl -s -b cookies.txt -H 'content-type: application/json' \
  -d '{"personaId":"fnb_high_credit"}' \
  http://localhost:5173/api/simulator/conversations |
  sed -E 's/.*"phone_number":"([0-9]+)".*/\1/')
for m in hola si 12345678; do
  curl -b cookies.txt -H 'content-type: application/json' \
    -d "{\"phoneNumber\":\"$phone\",\"message\":\"$m\"}" \
    http://localhost:5173/api/simulator/message
done
curl -b cookies.txt http://localhost:5173/api/simulator/conversation/$phone
```

The server chooses the new conversation's phone number and returns it in
`phone_number`. It takes one past the highest simulated number (`519` and eight
digits) on the tenant's default channel account, starting at `51900000001`. It
skips `51999999999`, which the replay of a real conversation uses, and any
number a real conversation holds. A deleted conversation never frees a number
another simulation holds.

Without `OPENAI_API_KEY`, a message the bot's patterns do not recognize gets no
reply, the backend logs "Message processing failed", and the simulator answers
500 with `{"status":"failed","error":"..."}`. Set the key in `.dev.vars` to let
the bot answer questions and recover from unclear replies.

## Next

- [How a conversation runs](./conversation.md) explains what just happened.
- [Connecting WhatsApp](./whatsapp.md) connects a real number.
- [Deploy](./deploy.md) puts it on Cloudflare.
- [Development](./development.md) lists the checks to run before a change.
