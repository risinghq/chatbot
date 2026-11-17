import { Hono } from "hono";
import { pathParam } from "../lib/http.ts";
import type { Context } from "hono";
import { WhatsAppService } from "../adapters/whatsapp/index.ts";
import { PersonasService } from "../domains/personas/index.ts";
import { ChannelAccountService } from "../domains/channels/accounts.ts";
import {
  getOrCreateConversation,
  resetSession,
} from "../conversation/index.ts";
import { conversationStub, unlocked } from "../conversation/stub.ts";
import { findConversation } from "../conversation/store.ts";
import {
  activeTenantId,
  requireActiveTenant,
  requireRole,
} from "../middleware/auth.ts";
import type { Conversation, ConversationRef } from "@vendeya/types";
import { createLogger } from "../lib/logger.ts";
import { getAll, getOne, run } from "../db/index.ts";

const logger = createLogger("simulator");

const simulator = new Hono();

// The simulator writes conversations, so it always needs a concrete tenant.
simulator.use("/*", requireActiveTenant);
simulator.use("/*", requireRole("admin", "developer"));

/**
 * Simulated conversations still belong to a channel account: they are stored in
 * the same table and share its identity. The tenant's default account is used.
 */
async function simulatorRef(
  c: Context,
  phoneNumber: string,
): Promise<ConversationRef | null> {
  const tenantId = activeTenantId(c);
  const account = await ChannelAccountService.getDefaultForTenant(tenantId);

  if (!account) return null;

  return {
    tenantId,
    channelAccountId: account.id,
    phoneNumber,
  };
}

/**
 * The conversation being replayed belongs to the tenant but not necessarily to
 * the number the simulator runs on. A business with two WhatsApp numbers has
 * two separate threads with the same contact, and `channelAccountId` says which
 * one is being loaded. Without it the default account is assumed.
 */
async function replaySourceRef(
  c: Context,
  phoneNumber: string,
  channelAccountId?: string,
): Promise<ConversationRef | null> {
  if (!channelAccountId) return await simulatorRef(c, phoneNumber);

  const tenantId = activeTenantId(c);
  const account = await ChannelAccountService.getById(channelAccountId);

  // Another tenant's account is indistinguishable from one that does not exist.
  if (!account || account.tenant_id !== tenantId) return null;

  return { tenantId, channelAccountId, phoneNumber };
}

const NO_ACCOUNT = {
  error:
    "This tenant has no channel account yet; add one before using the simulator",
} as const;

/** Every replay is loaded onto this contact, on the tenant's default number. */
const SIMULATOR_PHONE = "51999999999";

const SIMULATED_FIRST_PHONE = 51900000001;

/**
 * Returns one past the highest simulated number on this account. Skips a number
 * a real conversation holds and the reserved replay contact.
 */
async function nextSimulatedPhone(ref: ConversationRef): Promise<string> {
  const highest = (
    await getOne<{ phone: number | null }>(
      `SELECT MAX(CAST(phone_number AS INTEGER)) AS phone FROM conversations
     WHERE tenant_id = ? AND channel_account_id = ? AND is_simulation = 1
       AND phone_number GLOB '519[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
       AND phone_number != ?`,
      [ref.tenantId, ref.channelAccountId, SIMULATOR_PHONE],
    )
  )?.phone;

  let candidate = highest ? highest + 1 : SIMULATED_FIRST_PHONE;
  while (
    String(candidate) === SIMULATOR_PHONE ||
    (await findConversation({ ...ref, phoneNumber: String(candidate) }))
  ) {
    candidate++;
  }
  return String(candidate);
}

// Get available test personas
simulator.get("/personas", async (c) => {
  return c.json(await PersonasService.getAll(activeTenantId(c)));
});

// Create new test persona
simulator.post("/personas", async (c) => {
  const user = c.get("user");
  const tenantId = activeTenantId(c);

  const { id, name, description, segment, clientName, dni, creditLine, nse } =
    await c.req.json();

  if (
    !id ||
    !name ||
    !description ||
    !segment ||
    !clientName ||
    !dni ||
    creditLine === undefined
  ) {
    return c.json({ error: "Missing required fields" }, 400);
  }

  try {
    const persona = await PersonasService.create(
      tenantId,
      { id, name, description, segment, clientName, dni, creditLine, nse },
      user.id,
    );
    return c.json(persona);
  } catch (error) {
    logger.error({ error, user: user.id, tenantId }, "Persona creation failed");
    return c.json({ error: "Failed to create persona" }, 500);
  }
});

// Update test persona
simulator.patch("/personas/:id", async (c) => {
  const personaId = pathParam(c, "id");
  const tenantId = activeTenantId(c);
  const updates = await c.req.json();

  try {
    await PersonasService.update(tenantId, personaId, updates);
    const updated = await PersonasService.getById(tenantId, personaId);
    return c.json(updated);
  } catch (error) {
    logger.error({ error, personaId, tenantId }, "Persona update failed");
    return c.json({ error: "Failed to update persona" }, 500);
  }
});

// Delete test persona
simulator.delete("/personas/:id", async (c) => {
  const personaId = pathParam(c, "id");
  const tenantId = activeTenantId(c);

  try {
    await PersonasService.delete(tenantId, personaId);
    return c.json({ status: "deleted" });
  } catch (error) {
    logger.error({ error, personaId, tenantId }, "Persona deletion failed");
    return c.json({ error: "Failed to delete persona" }, 500);
  }
});

/**
 * The simulated conversations on the simulator's number. Every route here that
 * takes a simulated conversation's phone number resolves it through
 * `simulatorRef`, and the frontend keys rows by phone number alone. A row on
 * another number would open a new empty thread or answer 404.
 */
simulator.get("/conversations", async (c) => {
  const ref = await simulatorRef(c, SIMULATOR_PHONE);
  if (!ref) return c.json(NO_ACCOUNT, 400);

  // Simulations on another number stay in the table. They show again if that
  // number becomes the default.
  const conversations = await getAll<Conversation>(
    `SELECT * FROM conversations
     WHERE tenant_id = ? AND channel_account_id = ? AND is_simulation = 1
     ORDER BY last_activity_at DESC`,
    [ref.tenantId, ref.channelAccountId],
  );

  return c.json(conversations);
});

// Create new test conversation
simulator.post("/conversations", async (c) => {
  const tenantId = activeTenantId(c);
  const { personaId } = await c.req.json();

  const account = await simulatorRef(c, SIMULATOR_PHONE);
  if (!account) return c.json(NO_ACCOUNT, 400);
  const ref = { ...account, phoneNumber: await nextSimulatedPhone(account) };

  // Validate persona if provided
  if (personaId) {
    const persona = await PersonasService.getById(tenantId, personaId);
    if (!persona) {
      return c.json({ error: "Invalid persona_id" }, 400);
    }
  }

  // Create new test conversation with persona
  const initialPhase = { phase: "greeting" };
  const initialMetadata = { createdAt: Date.now(), lastActivityAt: Date.now() };

  await run(
    `INSERT INTO conversations (tenant_id, channel_account_id, phone_number, context_data, status, is_simulation, persona_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      ref.tenantId,
      ref.channelAccountId,
      ref.phoneNumber,
      JSON.stringify({ phase: initialPhase, metadata: initialMetadata }),
      "active",
      1,
      personaId || null,
    ],
  );

  return c.json((await findConversation(ref))!);
});

// Send message in simulator
simulator.post("/message", async (c) => {
  const { phoneNumber, message } = await c.req.json();

  if (!phoneNumber || !message) {
    return c.json({ error: "phoneNumber and message required" }, 400);
  }

  const ref = await simulatorRef(c, phoneNumber);
  if (!ref) return c.json(NO_ACCOUNT, 400);

  await getOrCreateConversation(ref, true);

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
  if (!ref) return c.json(NO_ACCOUNT, 400);

  const conv = await getOrCreateConversation(ref, true);
  const messages = await WhatsAppService.getMessageHistory(ref, 100);

  return c.json({
    conversation: conv,
    messages: messages.reverse(), // chronological order
  });
});

// Reset simulator conversation
simulator.post("/reset/:phone", async (c) => {
  const ref = await simulatorRef(c, pathParam(c, "phone"));
  if (!ref) return c.json(NO_ACCOUNT, 400);

  await resetSession(ref);
  await WhatsAppService.clearMessageHistory(ref);

  return c.json({ status: "reset" });
});

// Delete simulator conversation
simulator.delete("/conversations/:phone", async (c) => {
  const ref = await simulatorRef(c, pathParam(c, "phone"));
  if (!ref) return c.json(NO_ACCOUNT, 400);

  const conv = await findConversation(ref);

  if (!conv) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  if (conv.is_simulation !== 1) {
    return c.json({ error: "Can only delete simulation conversations" }, 403);
  }

  await run(
    `DELETE FROM conversations
     WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
    [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
  );

  await WhatsAppService.clearMessageHistory(ref);

  return c.json({ status: "deleted" });
});

// Load conversation into simulator (for replay/debugging)
simulator.post("/load", async (c) => {
  const { sourcePhone, sourceChannel } = await c.req.json();

  if (!sourcePhone) {
    return c.json({ error: "sourcePhone required" }, 400);
  }

  // The replay always loads onto the default account, where the rest of the
  // simulator looks for it. Only the source is read from the number the
  // conversation happened on.
  const targetRef = await simulatorRef(c, SIMULATOR_PHONE);
  if (!targetRef) return c.json(NO_ACCOUNT, 400);

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
  await resetSession(targetRef);
  await WhatsAppService.clearMessageHistory(targetRef);

  // Create/update simulator conversation with source data
  await getOrCreateConversation(targetRef, true);

  // Update context data and state
  await run(
    `UPDATE conversations
     SET context_data = ?,
       client_name = ?,
       dni = ?,
       segment = ?,
       credit_line = ?,
       nse = ?,
       is_calidda_client = ?
     WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
    [
      sourceConv.context_data,
      sourceConv.client_name,
      sourceConv.dni,
      sourceConv.segment,
      sourceConv.credit_line,
      sourceConv.nse,
      sourceConv.is_calidda_client,
      targetRef.tenantId,
      targetRef.channelAccountId,
      targetRef.phoneNumber,
    ],
  );

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
