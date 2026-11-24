# Campaigns and reminders

A business sends a WhatsApp message to a chosen group of customers, now or at a
set time, and keeps two standing reminders: one for an abandoned cart, one for a
customer who stopped buying. Everything shares one mechanism — a Meta message
template, an audience, and the same outbox that carries replies, so retries and
handoffs behave as they do elsewhere ([conversation](./conversation.md)).

## Templates

WhatsApp lets a business open a conversation outside the 24-hour
customer-service window only with a template Meta approved. A template is a
name, a language, a category (`marketing` or `utility`), and a body with
`{{1}}`-style parameters. A parameter is fixed text or a field bound per
recipient: `customer_name`, `order_number`, `order_total`, `pay_link`.

Creating a template registers it with the Graph API
(`POST /{waba-id}/message_templates`) and stores it `pending`. Meta reports the
review on the `message_template_status_update` webhook field, which the worker
applies to the template's status. Only an `approved` template can send: a
campaign on another status fails, a reminder on one skips its send.

The webhook for a review names the WABA, not a phone number, so the worker
verifies its signature against the app secret of the account whose `waba_id`
matches, same as for a message.

## Audiences

A campaign's audience is one of:

- `all`: every customer with a phone.
- `category` / `product`: customers who bought from a category or product.
- `inactive`: customers with no delivered order or inbound message in `days`.
- `phones`: a pasted list of phones, normalized like customer phones and not
  required to be customers.

`POST /api/campaigns/audience-count` returns how many phones an audience
selects; the dashboard calls it as the form changes.

## Consent and limits

- A customer who writes `baja`, `stop` or `no más mensajes` is opted out of
  marketing. The assistant answers with a fixed confirmation and no marketing
  template reaches them again. Staff see and change the opt-out on the
  customer's page.
- A customer gets at most one marketing send every `marketing_min_interval_days`
  days (default 7). A capped recipient is recorded `skipped` with reason
  `capped`; an opted-out one with `opted_out`.
- Utility reminders about the customer's own order are not marketing and skip
  both rules.

## Sending

A campaign with `scheduled_at` in the past is dispatched as soon as it is
created; a future one waits for the minute sweep, which runs
`dispatchDueCampaigns` before the outbox check so a send lands on the wire in
the same pass. Dispatch materializes the audience into `campaign_recipients`
once, then enqueues each pending recipient's template send on the outbox inside
the consent rules. Cancel stops a campaign that is still `scheduled`.

## Reminders

Two reminders run on the same sweep, per business, when enabled:

- **Abandoned cart**: an order that stays `pending` with nothing confirmed paid
  and no inbound message for `hours` (default 4) gets one reminder, and the send
  stamps `orders.cart_reminder_sent_at`. The template's `pay_link` parameter
  resolves to the TAYPI link when the order has one.
- **Inactive customer**: a customer whose newest delivered order and newest
  inbound message are both older than `days` (default 45) gets one message per
  inactive spell, stamped on `customers.inactive_reminder_sent_at`. New activity
  after the stamp starts a new spell.

Each reminder sends with the template the business picks, `utility` or
`marketing`. A marketing send — from a campaign or a reminder — respects the
opt-out and the cap; `marketing_sends` records the last one per phone and the
cap reads only that record. A `utility` send skips both. A reminder with no
approved template set sends nothing.

## Results

`campaign_recipients` holds one row per phone with a status. Delivery statuses
from the `statuses` webhook move a row forward (`sent`, `delivered`, `read`,
`failed`); a message from the phone marks `replied_at`; orders the customer
places within 7 days of the send count with their total. The dashboard shows
targeted, sent, delivered, read, failed, skipped, replied, and the attributed
orders.

## Endpoints

All under `/api/campaigns`, tenant-scoped by session as every route
([tenancy](./tenancy.md)).

| Method & path                | Purpose                                  | Roles             |
| ---------------------------- | ---------------------------------------- | ----------------- |
| GET `/templates`             | List templates and their statuses        | all               |
| POST `/templates`            | Register a template with Meta            | admin, supervisor |
| POST `/audience-count`       | Count the phones an audience selects     | all               |
| GET `/`                      | List campaigns with results              | all               |
| POST `/`                     | Create a campaign (now or scheduled)     | admin, supervisor |
| POST `/:id/cancel`           | Cancel a scheduled campaign              | admin, supervisor |
| GET `/settings/reminders`    | Read reminder and marketing-cap settings | all               |
| PUT `/settings/reminders`    | Save reminder and marketing-cap settings | admin, supervisor |
| GET `/customers/:id/opt-out` | Read a customer's marketing opt-out      | all               |
| PUT `/customers/:id/opt-out` | Set a customer's marketing opt-out       | admin, supervisor |

The dashboard exposes the feature at `/{tenant}/campanas` in the business's
navigation: templates with their status, campaigns with their results, a create
form with the live audience count, and the two reminders with an on/off switch
and their `N`.
