# How a conversation runs

A customer's WhatsApp message becomes a reply in one bot turn. This document
follows the message from Meta's webhook to the reply on the customer's phone,
then describes how the assistant hands a conversation to a person and how a
person takes it over.

```text
webhook -> message_inbox -> wake the conversation's object
  object (holds the lock): send due replies -> answer the pending group -> handoff
  turn:  idle release -> mark read -> assistant (model + tools) ->
         pacing delay -> send -> record -> emit events
  send failure -> outbox -> the object's alarm -> handoff to a person
```

## The webhook

Meta posts a signed batch to the backend Worker at `/api/webhook`. How the
endpoint is set up and secured is in [Connecting WhatsApp](./whatsapp.md).

[`routes/webhook.ts`](../apps/backend/src/routes/webhook.ts) handles each
message in the batch on its own and reports a status for it in the 200 body:

| Status                                 | Meaning                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `received`                             | Stored in `message_inbox` for the conversation's object.                 |
| `duplicate`                            | Its Meta message id is already queued. Nothing is done.                  |
| `non_text_ignored`                     | Image, audio, video, document or unknown type. No reply, nothing stored. |
| `ignored_system_message`               | No sender.                                                               |
| `unroutable_no_phone_number_id`        | The change carries no `metadata.phone_number_id`. Dropped.               |
| `unknown_channel_account`              | No channel account has that id. Dropped.                                 |
| `channel_account_pending`, `_disabled` | The number is not active. Dropped.                                       |
| `tenant_not_active`                    | The business is suspended. Dropped.                                      |
| `no_message`                           | The change carried no message, such as a delivery status. Ignored.       |

A dropped message is gone: Meta got a 200 and does not redeliver it. A message
that throws while being stored makes the whole batch answer 500, so Meta
redelivers it, and the message id check skips the ones already stored.

Before storing a text message, the webhook creates the conversation if needed
and writes the inbound `messages` row. The dashboard shows it from there.

The webhook answers Meta once every message is stored. It then wakes the object
of each conversation that got a message, in `waitUntil`, so the turn runs after
the answer. A wake that fails is logged as "Waking the conversation failed; the
sweep wakes it", and the minute sweep wakes the conversation.

The backend ignores Meta's delivery and read statuses. A reply's `sent` status
means Meta accepted it, not that it was delivered.

## The inbox and the aggregator

Each conversation has one Durable Object,
[`ConversationObject`](../apps/backend/src/conversation/object.ts), named by the
conversation's tenant, channel account and phone. A wake runs one pass: send the
replies that are due ([the outbox](#the-outbox)), answer the pending messages,
then [hand off](#the-handoff) what failed. The pass ends by setting the object's
alarm to the next due moment, so the object wakes itself.

[`aggregator.ts`](../apps/backend/src/conversation/aggregator.ts) takes the
conversation's `pending` rows as one group and joins their text with spaces into
one message. The group waits for a quiet window: it is answered 2 s after its
newest message, and never later than 10 s after its oldest. Two messages sent
within 2 s of each other are answered in one turn. While the window is open the
alarm is set to its end.

Rows of a suspended tenant or an inactive number are skipped and stay `pending`
([`message-inbox.ts`](../apps/backend/src/conversation/message-inbox.ts)).
Different conversations run in parallel, each in its own object. Each row moves:

```text
pending -> processing -> processed    the turn recorded its result
                      -> pending      the number was switched off during the
                                      turn, or the turn failed for the first
                                      time
                      -> failed       the turn failed for the second time
```

A row becomes `processed` only in the batch that records the turn: the
conversation's activity or handoff and the row's own status commit together in
one D1 `batch()` (see [the turn](#the-turn)). A turn that throws before that,
anywhere in the reply step, leaves the rows unsettled. The object counts the
failure in `message_inbox.attempts` and keeps the error in `last_error`.
Attempts belong to the conversation, not the row: a message that arrives after
the first failure joins the retry and fails with the older ones. After the first
failure the group goes back to `pending` and the next pass runs its turn again.
After the second, every row of the group ends `failed`, and so does every
`pending` row of the conversation, including one that arrived while the second
attempt ran. [The handoff](#the-handoff) then gives the conversation to a person
with reason `turn_failed`, and no row is left to be answered after it. A turn
refused because the number was switched off counts no attempt.

An object that ends mid-turn, by a crash, an exceeded limit or a restart of the
Worker, leaves its rows `processing`. The write that records a turn's outcome
can leave them the same way if it throws. Every locked call into the object
settles such rows before anything else — under the lock none of them can still
be running — as one failed attempt with `last_error`
`interrupted: the turn ended mid-run`, on the same rule, so a message whose turn
never records reaches a person. When that is the second attempt, the
conversation's `pending` rows fail with it. The commit comes after the sends, so
a reply that went out before the object ended is sent again on the rerun, as
with a send that throws partway through a batch.

The minute sweep wakes every conversation of an open tenant with a pending group
past its quiet window, a row still `processing`, a reply due, or a failed row
not handed off. It catches a wake that was lost and a number or tenant switched
back on. One sweep wakes at most
[`MAX_WAKES_PER_SWEEP`](../apps/backend/src/sweep.ts) conversations, because
each wake spends one of the invocation's subrequests; a bigger backlog is woken
over successive sweeps.

Processed rows are kept 7 days, because the Meta message id on them is what
recognizes a redelivery
([`processed-retention.ts`](../apps/backend/src/conversation/processed-retention.ts)).

## The lock

Every turn, outbox attempt, handoff, takeover, release, decline and timed-out
reassignment runs inside the conversation's lock
([`conversation/locks.ts`](../apps/backend/src/conversation/locks.ts)). The lock
lives in the conversation's object. Every call for a conversation reaches its
one object, named `tenant:channel account:phone`, so the same contact writing to
two numbers has two conversations. Waiters queue in order.

The limit is 30 s and counts the wait. A call that never got the lock, or whose
work outlived the limit, answers `busy`. A call that never got the lock ran
nothing, and its inbox rows stay `pending`. Work that outlives the limit keeps
running and keeps the lock, and its rows stay `processing` until it settles. The
work holding the lock sets the alarm again when it ends. A dashboard takeover or
release that answers `busy` gets 409, "The conversation is busy. Try again in a
moment."

A manual message from an agent does not take the lock.

## The turn

[`handler/orchestrator.ts`](../apps/backend/src/conversation/handler/orchestrator.ts)
runs one turn for one grouped message:

1. Load the conversation, or create it on the first message. Release it if a
   person has held it 3 hours with no activity (see
   [the idle release](#the-idle-release)).
2. Mark the message read. Show the typing indicator unless a person holds the
   conversation (`human_takeover`).
3. If a person holds it, record the turn and stop. The assistant sends nothing.
   The message may alert the agent holding it ([Escalation](#escalation)).
4. Ask [the assistant](#the-assistant) for the turn: a reply, and the effects of
   the tools it called.
5. Wait out the rest of the pacing delay: `BOT_RESPONSE_DELAY_MS`, default 2300
   ms, counted from the customer's message. A message older than 10 minutes, or
   a turn with nothing to send, gets no delay.
6. Send the reply, then the product photos a tool asked for
   ([the send](#the-send)).
7. Record the turn. One D1 `batch()` writes the conversation's
   `last_activity_at`, or the handoff if the assistant handed off, and marks the
   turn's inbox rows `processed`. A batch commits whole or not at all.
8. Emit `order_created` for each order the turn filed. If the assistant handed
   off, assign an agent, raise the unread alert and emit `escalation_triggered`
   ([Escalation](#escalation)).

Events go out after the record. A turn that throws before it goes back to its
queue, so an event emitted earlier would be emitted twice.

If a send throws `ChannelUnavailableError` (the number was switched off
mid-turn), nothing after it runs and the inbox rows go back to `pending`. The
retry answers the message again, and a reply sent before the throw goes out
again. A turn that filed an order is the exception: it is recorded without its
reply, because a retry would file a second order.

The simulator calls the same `answerMessage`, through the conversation's object,
at once and with no inbox rows. Its conversations live on the business's
simulator channel (`channel_type = 'simulator'`), one per business, which
`ChannelAccountService.simulatorFor` creates on first use. The number listings
and the default account leave that channel out. A simulated turn reads the
business's real data and writes none: it writes each reply to `messages` as
`sent` and sends nothing, `create_order` answers with the order it would file,
and the turn marks nothing read and skips the events, the agent assignment and
the staff alerts. A failed simulated turn answers the simulator with the error
instead of retrying.

## The assistant

[`domains/assistant/agent.ts`](../apps/backend/src/domains/assistant/agent.ts)
answers a turn with an OpenAI model and a set of tools. The business shapes it
on the Asistente page: its instructions, FAQ and policies, the model
(`gpt-5-mini` by default) and the stock location it sells from. Each model call
sends the system prompt
([`prompt.ts`](../apps/backend/src/domains/assistant/prompt.ts)), which holds
those texts, the business's name and the customer the business has on file with
the conversation's phone number. It also sends up to the last 30 messages of the
last 24 hours. A reply that failed to send is left out, because the customer
never saw it.

The tools are in [`tools/`](../apps/backend/src/domains/assistant/tools/). Each
one checks its arguments and reads or writes through the business's own domains,
so the model cannot state a price or a stock level it did not read:

| Tool                   | Does                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `search_products`      | Finds active products by text or category.                  |
| `get_product`          | Reads a product's variants, prices and stock.               |
| `send_product_photos`  | Sends a product's photos after the reply.                   |
| `list_delivery_zones`  | Reads the delivery zones and their fees.                    |
| `list_payment_methods` | Reads the payment methods and their instructions.           |
| `get_customer`         | Reads the customer's saved record and addresses.            |
| `quote`                | Prices a cart with delivery.                                |
| `create_order`         | Files the order, and the customer if the business has none. |
| `hand_off`             | Passes the conversation to a person, with a reason.         |
| `check_calidda_credit` | Checks a DNI's Cálidda credit line.                         |

A business gets `check_calidda_credit` only with a Cálidda login, and the prompt
then tells the model to ask for a DNI only to pay with Cálidda credit. Without a
login the model is never offered the tool, and a call to it is refused like an
unknown tool. The tool answers whether the person qualifies and their credit
line, never the name or NSE the providers return
([Eligibility](./eligibility.md#in-a-conversation)).

A tool never sends a message or alerts anyone. It returns effects (photos to
send, an order filed, a handoff), and the turn carries them out. A turn makes at
most 6 tool calls; the next call allows none, so the model must answer in text.
Every model call is a row in `llm_calls`, whether it answers or throws.

The assistant calls OpenAI with the tenant's own key, stored encrypted as the
`openai_api_key` tenant secret. A real conversation of a business with no key is
handed off with reason `no_openai_key`, since no retry can answer it. The
simulator answers 409 instead. A model call that fails throws, and the turn is
retried and then handed off (see [the inbox](#the-inbox-and-the-aggregator)). If
the turn had already filed an order, it is handed off at once with reason
`assistant_unavailable` instead, because a retry would file the order again.

## The send

Every reply goes through `WhatsAppService` in
[`adapters/whatsapp/index.ts`](../apps/backend/src/adapters/whatsapp/index.ts).
It sends through the Cloud API
([`cloud-api.ts`](../apps/backend/src/adapters/whatsapp/cloud-api.ts), 10 s for
text, and 15 s for an image. The Graph version is set in
[WhatsApp](./whatsapp.md#connecting-whatsapp)). An image is sent as a link to
`<public url>/media/<tenant>/images/<id>.jpg`, which Meta fetches from R2
through the backend.

A bot reply:

1. If the conversation still owes an earlier reply, queues behind it: the reply
   is written to `messages` as `queued` and appended to the outbox with no
   attempt, so replies go out in the order the bot produced them. Otherwise it
   continues.
2. Re-reads the channel account. A missing account, a suspended tenant, or an
   account of another tenant is a `permanent` failure. A `pending` or `disabled`
   account throws `ChannelUnavailableError`, and the caller keeps the customer's
   message and answers it once the number is active again.
3. Sends, and gets back a typed outcome
   ([`types.ts`](../apps/backend/src/adapters/whatsapp/types.ts)):

| Outcome     | When                                                                          | Retried         |
| ----------- | ----------------------------------------------------------------------------- | --------------- |
| `ok`        | Meta returned a message id                                                    | no              |
| `transient` | HTTP 429 or 5xx; Meta codes 130429, 131056; connection refused; DNS failure   | yes             |
| `ambiguous` | timeout; other network error; 2xx without a message id. It may have gone out. | once, after 5 s |
| `permanent` | any other 4xx; no usable token; account refused                               | no              |

On `ok` the `messages` row is `sent` with Meta's id. Any other outcome of an
attempt goes on the outbox. A `permanent` one lands there already `failed`,
which starts [the handoff](#the-handoff). The rest are written `queued` and
retried. A suspended tenant's refusal in step 2 is written the same way, as a
`failed` row, but the handoff skips a suspended tenant: the customer hears
nothing, and the alert comes when the tenant reopens. A missing account or an
account of another tenant is returned as `permanent` with no row, because the
ref names no conversation to write one for.

An agent's manual reply takes none of this. It is sent once, and the agent sees
the failure in the dashboard. A reply that went out writes a `send_message`
audit row. An `ambiguous` one writes the same row with
`deliveryUnconfirmed: true` in its details, because it may have reached the
customer, and still answers a failure. It moves neither last activity nor the
unread alert. A `transient` or `permanent` one writes no row.

## The outbox

The `outbox` table holds a reply that may still go out. Its states and budget
are in [`conversation/outbox.ts`](../apps/backend/src/conversation/outbox.ts):

```text
pending  -> sending -> sent
                    -> failed      permanent, out of budget, second ambiguous
                    -> pending     transient: retry after 5 s, 30 s, 2 min, 10 min
pending  -> failed    older than 1 hour ("expired")
pending  -> cancelled a person took the conversation
```

A reply gets at most 5 attempts, the inline send counting as the first.

[`outbox-sender.ts`](../apps/backend/src/conversation/outbox-sender.ts) runs
first in each pass of the conversation's object, inside the lock. It expires
rows past an hour, then sends the due rows one at a time, lowest-numbered first,
and records each outcome on the outbox and `messages` rows in one batch. It
sends at most 10 rows a pass. The object's alarm is set to the next row's
`next_attempt_at`, so each retry runs on time. A number switched off defers the
row 60 s without counting an attempt. A row left `sending` by a call that ended
is recorded, by the next locked call, as one `ambiguous` attempt with reason
`interrupted`.

Final rows are deleted after 7 days, by the hourly sweep.

## The handoff

A `failed` row, in `outbox` or in `message_inbox`, means the customer did not
get a reply. [`handoff.ts`](../apps/backend/src/conversation/handoff.ts) runs
last in each pass of the conversation's object and looks for a `failed` row not
yet handed off. A suspended tenant's rows wait for it to reopen: the sweep wakes
the conversation again once it is open. Inside the lock it:

1. cancels the conversation's pending replies,
2. escalates the conversation if it is still `active`, and assigns it an agent,
3. records the unread alert and emits `escalation_triggered`,
4. stamps `handed_off_at` on the failed rows.

The reason is `turn_failed` when an inbox row failed, because no reply was
worked out, and `reply_undeliverable` when only outbox rows failed. The event's
`context.lastReason` carries the last error. A crash between steps 3 and 4
alerts twice. The customer is not told anything.

## The idle release

A person's hold on a conversation lasts while the conversation is active. At the
start of a turn, a conversation in `human_takeover` whose `last_activity_at` is
3 hours or more in the past is released
([`store.ts`](../apps/backend/src/conversation/store.ts)): `status` goes back to
`active`, the handover reason and the assigned agent are cleared, and the
assistant answers the message. It happens only when the customer writes again.

`last_activity_at` moves when a turn is recorded, when a person takes the
conversation over or releases it, and when an agent sends a manual message. A
customer message to a held conversation also records a turn, so the hold ends
only after 3 hours in which neither side wrote.

The assistant needs no reset of its own. It reads the messages of the last 24
hours, not a stored state.

## Escalation

The conversation goes to a person when:

- the assistant calls `hand_off`, with the reason it gives,
- the business has no OpenAI key (`no_openai_key`),
- the model fails after the turn filed an order (`assistant_unavailable`),
- a reply cannot be delivered (`reply_undeliverable`),
- a turn fails twice (`turn_failed`).

Handing off sets `conversations.status` to `human_takeover` and
`handover_reason` to the reason, and emits `escalation_triggered`. The assistant
tells the customer someone will write soon. The other reasons send nothing.

The alert goes to the conversation's assigned agent if it has one, else to the
tenant's sales target, the `whatsapp_group_sales` tenant setting. A tenant
without it gets no group alert; there is no platform fallback
([`notifications/resolver.ts`](../apps/backend/src/domains/notifications/resolver.ts)).
The turn that hands a conversation off also assigns it before the alert goes
out, so the alert reaches the assigned agent. The round-robin in
[`conversations/assignment.ts`](../apps/backend/src/domains/conversations/assignment.ts)
picks the next available `sales_agent` of the tenant, stamps
`assignment_notified_at`, and notifies the agent (`agent_assigned`). With no
available agent the conversation stays unassigned and the alert goes to the
sales target. The undeliverable-reply handoff hands off and assigns the same
way.

A conversation hands off once. While it stays `human_takeover`, a later customer
message neither emits `escalation_triggered` nor assigns again. It can emit
`customer_message_received`, which goes to the assigned agent only, never to the
sales target, with its own text ("escribió en la conversación que atiendes") and
the conversation link. The agent has to be able to hear it: the agent has a
phone number.

Whoever holds the conversation gets at most one alert until they answer. The
`unread_alerts` row and its transitions are in
[Unread alert](./architecture.md#unread-alert). A customer who keeps writing
after the escalation alert therefore costs no further alert. A customer who
writes after the agent answered, or after the conversation went to another
agent, costs one.

An assignment waits for the agent to take the conversation over, which clears
`assignment_notified_at`. If 5 minutes pass first, a timer (checked every 60 s)
passes the conversation to the next available agent. The agent can also decline
(`POST /api/conversations/:phone/decline-assignment`), which does the same at
once. Both run under the conversation lock, and decline answers 409 while the
conversation is busy. Assigning leaves the conversation `human_takeover`, so the
assistant stays silent while an agent holds it.

An agent also becomes assigned by taking the conversation over (below).

## Takeover and release

An agent takes a conversation from the dashboard:

- **Takeover** (`POST /api/conversations/:phone/takeover`) sets the conversation
  to `human_takeover` with reason "Manual takeover by agent" and cancels the
  replies the bot still owed. A turn already running may still send what it had
  ready. It also assigns the conversation to the person who takes it and accepts
  a pending assignment (it clears `assignment_notified_at`). A conversation
  already assigned to someone else is refused with 409, and the same person may
  repeat the takeover.
- **Manual message** (`POST /api/conversations/:phone/message`) sends once and
  moves `last_activity_at`. It works whether or not a person holds the
  conversation.
- **Release** (`POST /api/conversations/:phone/release`) gives a held
  conversation back to the assistant, as the idle release does. The customer's
  next message is answered by the assistant, which reads the whole recent
  conversation, including what the person wrote. A release clears the assigned
  agent of a conversation a person held, so another agent can take it. Releasing
  a conversation the assistant owns does nothing.

These are in
[`domains/conversations/write.ts`](../apps/backend/src/domains/conversations/write.ts).
