# Connecting WhatsApp

Each business number is a channel account on a tenant (see
[Tenancy](./tenancy.md#channel-accounts)). Connecting one takes four values from
Meta and one registration call:

| Value                        | From Meta                                | Stored as                          |
| ---------------------------- | ---------------------------------------- | ---------------------------------- |
| Phone number id              | the number's id in the WhatsApp settings | `channel_accounts.phone_number_id` |
| WhatsApp Business Account id | the account the number belongs to        | `channel_accounts.waba_id`         |
| Permanent access token       | a system user's token                    | encrypted in `channel_secrets`     |
| App secret                   | the Meta app's basic settings            | encrypted in `channel_secrets`     |

The phone number id is not the phone number.

## Meta's side

These steps happen in Meta's consoles. This repository cannot check them, and
Meta changes them without notice. Meta's guide is at
<https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started>.

1. At <https://developers.facebook.com/apps>, create an app and add the use case
   "Connect with customers through WhatsApp".
2. In the app's WhatsApp settings, open "Manage phone numbers", add the business
   number and verify it. Note its phone number id and the WhatsApp Business
   Account id.
3. In Business Manager, <https://business.facebook.com/settings>, open Users >
   System users and create a system user with the admin role.
4. Assign the system user two assets, the app and the WhatsApp number, with full
   control of each.
5. On the system user, generate a token for the app, with no expiry and the
   WhatsApp permissions (`whatsapp_business_messaging`,
   `whatsapp_business_manage_events`). This is the permanent access token.
6. Copy the app secret from the app's basic settings.
7. Configure the webhook, as described below, once the channel account exists.

The backend calls one Graph endpoint with the token,
`POST https://graph.facebook.com/<version>/<phone number id>/messages`, to send
replies and mark messages read
([`cloud-api.ts`](../apps/backend/src/adapters/whatsapp/cloud-api.ts)). The
version is `GRAPH_API_VERSION`, `v26.0` when unset. A value that does not look
like `v26.0` makes every send throw. `GRAPH_API_BASE_URL` replaces
`https://graph.facebook.com`, for a proxy or a fake server. Every Graph URL is
built by `graphUrl` in [`config/graph.ts`](../apps/backend/src/config/graph.ts).

## Registering the number

A platform operator registers the number from the command line, with no deploy.
The command reads the access token and the app secret from hidden prompts:

```sh
SECRETS_KEY=<the deployed key> bun run account channel create --tenant <tenant id> \
  --phone-number-id <phone number id> --waba-id <whatsapp business account id> \
  --display-phone-number "+51 999 999 999" --label Ventas --remote
```

[Operations](./operations.md#accounts) explains the key and the other forms. The
system generates the number's webhook verify token when the account is created;
the business's Canales page (`/dashboard/<tenant id>/admin/channels`) shows it
with the webhook URL.

A tenant admin, or a platform operator, can also register the number through the
API, naming the business in `X-Tenant-Id`. `SECRETS_KEY` must be set on the
backend, or a request carrying a credential answers 503.

```sh
curl -X POST -b "session=<token>" -H "X-Tenant-Id: <tenant id>" \
  -H 'content-type: application/json' \
  -d '{
    "phoneNumberId": "<phone number id>",
    "wabaId": "<whatsapp business account id>",
    "displayPhoneNumber": "+51 999 999 999",
    "label": "Ventas",
    "accessToken": "<permanent access token>",
    "appSecret": "<app secret>"
  }' \
  https://sales.rising.sh/api/admin/channels
```

The answer is the account with its `verify_token` and `webhook_url`; the access
token and app secret never come back, only `has_access_token` and
`has_app_secret`. An account created with an access token is `active` at once. A
`phoneNumberId` another account holds answers 409. The routes are in
[`routes/admin/channels.ts`](../apps/backend/src/routes/admin/channels.ts).

To list the tenant's numbers, replace a token, or switch a number off:

```sh
curl -b "session=<token>" -H "X-Tenant-Id: <tenant id>" \
  https://sales.rising.sh/api/admin/channels
curl -X PATCH -b "session=<token>" -H "X-Tenant-Id: <tenant id>" \
  -H 'content-type: application/json' \
  -d '{"accessToken":"<new token>"}' https://sales.rising.sh/api/admin/channels/<id>
curl -X PATCH -b "session=<token>" -H "X-Tenant-Id: <tenant id>" \
  -H 'content-type: application/json' \
  -d '{"status":"disabled"}' https://sales.rising.sh/api/admin/channels/<id>
```

`status` accepts `active`, `pending` and `disabled`. An account with no access
token cannot be made `active`.

The local seed registers a `pending` placeholder number for the demo business,
with no Meta credentials
([`db/seeds/demo.ts`](../apps/backend/src/db/seeds/demo.ts)). A real number is
registered as above.

## The callback URL

In the app's WhatsApp configuration, set the callback URL to the public host
followed by `/api/webhook`:

```text
https://sales.rising.sh/api/webhook
```

The backend Worker's route on `/api/*` takes the request straight from Meta
([`routes/webhook.ts`](../apps/backend/src/routes/webhook.ts)).

Then subscribe the app to the number's `messages` webhook field. The backend
reads only the `messages` in a delivery and ignores delivery statuses.

## The verification handshake

When the callback URL is saved, Meta sends a GET with `hub.mode=subscribe`, a
`hub.verify_token` and a `hub.challenge`. The backend answers the challenge if
the token matches the verify token of any channel account. Anything else
answers 403. The handshake carries no phone number id, so any stored verify
token passes it. Each business's Canales page shows its numbers' tokens.

```sh
curl "https://sales.rising.sh/api/webhook?hub.mode=subscribe&hub.verify_token=<verify token>&hub.challenge=42"
```

prints `42`.

## The webhook signature

Meta signs every delivery with the app secret, in the header
`X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`. The backend
reads the phone number ids the body names, finds each number's channel account,
and checks the signature against every named account's app secret before
processing anything. A number that is not registered, an account with no app
secret, a missing header or a mismatch all answer 401 and nothing is stored
([`routes/webhook.ts`](../apps/backend/src/routes/webhook.ts)). A delivery that
names numbers on several channel accounts must verify against each of them,
which in practice means the numbers belong to Meta apps that share the app
secret.

A signed test delivery with no messages:

```sh
body='{"entry":[]}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$WHATSAPP_APP_SECRET" | sed 's/^.* //')
curl -X POST -H 'content-type: application/json' \
  -H "X-Hub-Signature-256: sha256=$sig" -d "$body" \
  https://sales.rising.sh/api/webhook
```

prints `{"results":[]}`. Each message of a real delivery adds one entry with its
`phoneNumberId` and its `status`
([Conversation](./conversation.md#the-webhook)).

## Body size

Meta documents webhook payloads of up to 3 MB. The backend refuses a body over 3
MiB with 413, before it checks the signature, and stops reading a chunked body
at the limit. A refused delivery is not stored.
