import { Hono } from "hono";
import { pathParam } from "../lib/http.ts";
import type { Context } from "hono";
import { WhatsAppService } from "../adapters/whatsapp/index.ts";
import { ChannelAccountService } from "../domains/channels/accounts.ts";
import { hasOpenAiApiKey } from "../domains/settings/openai.ts";
import {
  createConversation,
  ensureConversation,
  findConversation,
  release,
} from "../conversation/store.ts";
import { conversationStub, unlocked } from "../conversation/stub.ts";
import { recordAd } from "../domains/ads/index.ts";
import {
  activeTenantId,
  requireRole,
  requireTenantScope,
} from "../middleware/auth.ts";
import type { Conversation, ConversationRef } from "@vendeya/types";
import { sql } from "kysely";
import { createLogger } from "../lib/logger.ts";
import { db } from "../db/index.ts";

const logger = createLogger("simulator");

const simulator = new Hono();

// The simulator writes conversations, so it always needs a concrete tenant.
simulator.use("/*", requireTenantScope);
simulator.use("/*", requireRole("admin", "developer"));

/**
 * Simulated conversations live on the tenant's simulator channel, apart from
 * its WhatsApp numbers, so the simulator works before any number exists.
 */
async function simulatorRef(
  c: Context,
  phoneNumber: string,
): Promise<ConversationRef> {
  const tenantId = activeTenantId(c);
  const account = await ChannelAccountService.simulatorFor(tenantId);
  return { tenantId, channelAccountId: account.id, phoneNumber };
}

/**
 * The real conversation being replayed. A business with two WhatsApp numbers
 * has two separate threads with the same contact, and `channelAccountId` says
 * which one is being loaded. Without it the default number is assumed.
 */
async function replaySourceRef(
  c: Context,
  phoneNumber: string,
  channelAccountId?: string,
): Promise<ConversationRef | null> {
  const tenantId = activeTenantId(c);
  const account = channelAccountId
    ? await ChannelAccountService.getById(channelAccountId)
    : await ChannelAccountService.getDefaultForTenant(tenantId);

  // Another tenant's account is indistinguishable from one that does not exist.
  if (!account || account.tenant_id !== tenantId) return null;

  return { tenantId, channelAccountId: account.id, phoneNumber };
}

/** Every replay is loaded onto this contact, on the simulator channel. */
const SIMULATOR_PHONE = "51999999999";

const SIMULATED_FIRST_PHONE = 51900000001;

/**
 * A new simulation on this account, on one past the highest simulated number.
 * The insert claims the number, so two simulations created at once each get
 * their own; one that finds its number taken tries the next.
 */
async function createSimulation(
  account: Omit<ConversationRef, "phoneNumber">,
): Promise<Conversation> {
  for (let candidate = await firstSimulatedPhone(account); ; candidate++) {
    if (String(candidate) === SIMULATOR_PHONE) continue;
    const created = await createConversation(
      { ...account, phoneNumber: String(candidate) },
      true,
    );
    if (created) return created as Conversation;
  }
}

async function firstSimulatedPhone(
  account: Omit<ConversationRef, "phoneNumber">,
): Promise<number> {
  const highest = (
    await db
      .selectFrom("conversations")
      .select(
        sql<number | null>`max(cast(phone_number as integer))`.as("phone"),
      )
      .where("tenant_id", "=", account.tenantId)
      .where("channel_account_id", "=", account.channelAccountId)
      .where("is_simulation", "=", 1)
      .where(
        sql<boolean>`phone_number glob '519[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'`,
      )
      .where("phone_number", "!=", SIMULATOR_PHONE)
      .executeTakeFirst()
  )?.phone;
  return highest ? highest + 1 : SIMULATED_FIRST_PHONE;
}

/**
 * The simulated conversations on the simulator channel. Every route here
 * resolves a phone number through `simulatorRef`, so the frontend keys rows by
 * phone number alone.
 */
simulator.get("/conversations", async (c) => {
  const ref = await simulatorRef(c, SIMULATOR_PHONE);
  const conversations = (await db
    .selectFrom("conversations")
    .selectAll()
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("is_simulation", "=", 1)
    .orderBy("last_activity_at", "desc")
    .execute()) as unknown as Conversation[];

  return c.json(conversations);
});

// Create new test conversation
simulator.post("/conversations", async (c) => {
  const { phoneNumber: _replay, ...account } = await simulatorRef(
    c,
    SIMULATOR_PHONE,
  );
  return c.json(await createSimulation(account));
});

// What the simulator needs before a message can get an answer.
simulator.get("/status", async (c) =>
  c.json({ hasOpenAiKey: await hasOpenAiApiKey(activeTenantId(c)) }),
);

// Send message in simulator
simulator.post("/message", async (c) => {
  const { phoneNumber, message, referral } = await c.req.json();

  if (!phoneNumber || !message) {
    return c.json({ error: "phoneNumber and message required" }, 400);
  }
  if (referral !== undefined && typeof referral?.sourceId !== "string") {
    return c.json(
      { error: "referral needs a sourceId, like a click-to-WhatsApp ad's" },
      400,
    );
  }

  if (!(await hasOpenAiApiKey(activeTenantId(c)))) {
    return c.json(
      { error: "The business has no OpenAI key", reason: "no_openai_key" },
      409,
    );
  }

  const ref = await simulatorRef(c, phoneNumber);

  await ensureConversation(ref, true);

  // A simulated ad click records the ad like a real referral, so the
  // attribution flow can be shown without Meta.
  if (referral) {
    await recordAd(
      ref,
      {
        sourceId: referral.sourceId,
        headline: referral.headline ?? null,
        ctwaClid: referral.ctwaClid ?? null,
      },
      Date.now(),
    );
  }

  await WhatsAppService.logMessage(ref, "inbound", "text", message, "received");

  // The turn runs in the conversation's object and the answer waits for it.
  try {
    unlocked(
      ref,
      await conversationStub(ref).simulate({
        ref,
        content: message,
        timestamp: Date.now(),
        messageId: `sim-${Date.now()}`,
      }),
    );
  } catch (error) {
    // The simulator has no queue to retry the turn or hand it off, so the
    // caller is told that no reply was recorded.
    logger.error({ error, ref }, "Simulated turn failed");
    return c.json(
      {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }

  return c.json({ status: "processed" });
});

// Get conversation state for simulator
simulator.get("/conversation/:phone", async (c) => {
  const ref = await simulatorRef(c, pathParam(c, "phone"));

  const conv = await ensureConversation(ref, true);
  const messages = await WhatsAppService.getMessageHistory(ref, 100);

  return c.json({
    conversation: conv,
    messages: messages.reverse(), // chronological order
  });
});

// Reset simulator conversation
simulator.post("/reset/:phone", async (c) => {
  const ref = await simulatorRef(c, pathParam(c, "phone"));

  await release(ref);
  await WhatsAppService.clearMessageHistory(ref);

  return c.json({ status: "reset" });
});

// Delete simulator conversation
simulator.delete("/conversations/:phone", async (c) => {
  const ref = await simulatorRef(c, pathParam(c, "phone"));

  const conv = await findConversation(ref);

  if (!conv) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  if (conv.is_simulation !== 1) {
    return c.json({ error: "Can only delete simulation conversations" }, 403);
  }

  await db
    .deleteFrom("conversations")
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("phone_number", "=", ref.phoneNumber)
    .execute();

  await WhatsAppService.clearMessageHistory(ref);

  return c.json({ status: "deleted" });
});

// Load conversation into simulator (for replay/debugging)
simulator.post("/load", async (c) => {
  const { sourcePhone, sourceChannel } = await c.req.json();

  if (!sourcePhone) {
    return c.json({ error: "sourcePhone required" }, 400);
  }

  const targetRef = await simulatorRef(c, SIMULATOR_PHONE);

  const sourceRef = await replaySourceRef(c, sourcePhone, sourceChannel);

  // Source must be a conversation in the caller's own tenant.
  const sourceConv = sourceRef ? await findConversation(sourceRef) : null;

  if (!sourceRef || !sourceConv) {
    return c.json({ error: "Source conversation not found" }, 404);
  }

  const sourceMessages = await WhatsAppService.getMessageHistory(
    sourceRef,
    1000,
  );

  // Reset simulator first
  await release(targetRef);
  await WhatsAppService.clearMessageHistory(targetRef);

  // The replay copies the messages only. The customer stays with the real
  // phone number, so the assistant meets the replay as a new contact.
  await ensureConversation(targetRef, true);

  // Copy messages in chronological order
  for (const msg of sourceMessages.reverse()) {
    await WhatsAppService.logMessage(
      targetRef,
      msg.direction,
      msg.type,
      msg.content,
      msg.status,
      msg.product_id ?? undefined,
    );
  }

  return c.json({
    status: "loaded",
    simulatorPhone: SIMULATOR_PHONE,
    messageCount: sourceMessages.length,
  });
});

export default simulator;
