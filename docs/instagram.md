# Connecting Instagram

An Instagram professional account is a channel account with `channel_type`
`instagram` (see [Tenancy](./tenancy.md#channel-accounts)). Its direct messages
go to the same assistant as WhatsApp. A comment on one of its posts gets a
public reply and a private reply that opens a DM.

| Value                | From Meta                                     | Stored as                          |
| -------------------- | --------------------------------------------- | ---------------------------------- |
| Instagram account id | the professional account's id                 | `channel_accounts.phone_number_id` |
| Access token         | an Instagram user token with the scopes below | encrypted in `channel_secrets`     |
| App secret           | the Meta app's Instagram settings             | encrypted in `channel_secrets`     |

## Meta's side

These steps happen in Meta's consoles. This repository cannot check them. Meta's
guide is at
<https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login>.

1. At <https://developers.facebook.com/apps>, add the Instagram use case to the
   app, with the API setup that uses Instagram login.
2. Add the business's professional account and generate its token with the
   scopes `instagram_business_basic`, `instagram_business_manage_messages` and
   `instagram_business_manage_comments`. Note the account's id.
3. Copy the Instagram app secret.
4. Once the channel account exists, set the webhook callback to its
   `webhook_url` and verify token, and subscribe the fields `messages` and
   `comments`.

The backend sends to `https://graph.instagram.com/<version>/...`
([`api.ts`](../apps/backend/src/adapters/instagram/api.ts)). The version is
`GRAPH_API_VERSION`, shared with WhatsApp. `INSTAGRAM_GRAPH_BASE_URL` replaces
`https://graph.instagram.com`, for a proxy or a fake server.

## Registering the account

A platform operator registers it from the command line, or on the Canales page
(`/dashboard/<tenant id>/admin/channels`) by choosing Instagram:

```sh
SECRETS_KEY=<the deployed key> bun run account channel create --instagram \
  --tenant <tenant id> --phone-number-id <instagram account id> \
  --display-phone-number @mitienda --label Instagram --remote
```

Through the API, the body of `POST /api/admin/channels` carries
`"channelType": "instagram"`. The answer's `webhook_url` ends in
`/api/webhook/instagram`.
[Connecting WhatsApp](./whatsapp.md#registering-the-number) shows the rest of
the call.

## Direct messages

[`instagram-webhook.ts`](../apps/backend/src/routes/instagram-webhook.ts) checks
the `X-Hub-Signature-256` of every entry against its account's app secret, then
hands each text DM to the same intake as WhatsApp
([How a conversation runs](./conversation.md)). The account's own echoes and
deleted messages are dropped. The customer's id on Instagram is the IGSID, so
the assistant asks for a phone number before it creates an order.

Meta allows a reply up to 24 hours after the customer's last message. A person
on the team may answer for up to 7 days, and the send carries the `HUMAN_AGENT`
tag. After that a send fails as `outside_window`.

## Comments

A new top-level comment on the account's posts gets, once per comment id:

1. a public reply under the comment, and
2. a private reply, a DM to the commenter. Their answer opens a conversation
   with the assistant.

The account's own comments and replies in a thread are skipped. Admins edit both
texts on the Canales page, or with `GET` and
`PUT /api/admin/instagram/comments`. An empty text skips that reply.
`enabled: false` stops both.
