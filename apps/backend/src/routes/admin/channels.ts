import { Hono } from "hono";
import { pathParam } from "../../lib/http.ts";
import { ChannelAccountService } from "../../domains/channels/accounts.ts";
import { isEncryptionAvailable } from "../../platform/crypto/secrets.ts";
import { logAction } from "../../platform/audit/logger.ts";
import {
  activeTenantId,
  requirePlatformOperator,
  requireTenantScope,
} from "../../middleware/auth.ts";
import { publicOrigin } from "../../config.ts";
import type { ChannelAccount } from "@vendeya/types";

const channels = new Hono();

channels.use("/*", requireTenantScope);

/**
 * Access token and app secret never leave the server. The verify token does:
 * whoever connects the number pastes it into Meta's console, so the API reads
 * it back. `webhookUrl` is where Meta posts for this deployment.
 */
async function present(account: ChannelAccount) {
  return {
    id: account.id,
    tenant_id: account.tenant_id,
    channel_type: account.channel_type,
    waba_id: account.waba_id,
    phone_number_id: account.phone_number_id,
    display_phone_number: account.display_phone_number,
    label: account.label,
    status: account.status,
    has_access_token: account.access_token_secret_id !== null,
    has_app_secret: account.app_secret_secret_id !== null,
    verify_token: await ChannelAccountService.getVerifyToken(account),
    webhook_url:
      account.channel_type === "instagram"
        ? `${publicOrigin()}/api/webhook/instagram`
        : `${publicOrigin()}/api/webhook`,
    created_at: account.created_at,
    updated_at: account.updated_at,
  };
}

/**
 * The first of `fields` that `body` carries as something other than a string,
 * or null. Absent (undefined or null) is fine, and so is an empty string, which
 * the handlers treat as absent.
 */
function malformedField(
  body: Record<string, unknown>,
  fields: string[],
): string | null {
  for (const field of fields) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return field;
  }
  return null;
}

channels.get("/", async (c) => {
  const tenantId = activeTenantId(c);
  const accounts = await ChannelAccountService.listForTenant(tenantId);
  return c.json({
    accounts: await Promise.all(accounts.map(present)),
  });
});

/**
 * Claiming a number routes its inbound traffic to the acting tenant, and this
 * application cannot check who owns it on Meta's side. VendeYa onboards numbers
 * as a managed service, so only a platform operator creates one. A tenant admin
 * keeps the list and the PATCH, which reach only the tenant's own numbers.
 */
channels.post("/", requirePlatformOperator, async (c) => {
  const user = c.get("user");
  const tenantId = activeTenantId(c);
  const body = await c.req.json();

  const { phoneNumberId, wabaId, displayPhoneNumber, label } = body;
  const accessToken: string | undefined = body.accessToken;
  const appSecret: string | undefined = body.appSecret;
  const channelType: unknown = body.channelType ?? "whatsapp";

  if (channelType !== "whatsapp" && channelType !== "instagram") {
    return c.json({ error: "channelType must be whatsapp or instagram" }, 400);
  }
  if (!phoneNumberId) {
    return c.json({ error: "phoneNumberId is required" }, 400);
  }

  const malformed = malformedField(body, ["accessToken", "appSecret"]);
  if (malformed) {
    return c.json({ error: `${malformed} must be a string` }, 400);
  }

  // Create always stores the generated verify token encrypted, so a channel
  // account can never be created without the key.
  if (!isEncryptionAvailable()) {
    return c.json(
      {
        error:
          "SECRETS_KEY is not configured; credentials cannot be stored encrypted",
      },
      503,
    );
  }

  const existing = await ChannelAccountService.getByPhoneNumberId(
    phoneNumberId,
    channelType,
  );
  if (existing) {
    return c.json({ error: "That account id is already registered" }, 409);
  }

  const account = await ChannelAccountService.create({
    tenantId,
    phoneNumberId,
    wabaId: wabaId ?? null,
    displayPhoneNumber: displayPhoneNumber ?? null,
    label: label ?? null,
    accessToken: accessToken ?? null,
    appSecret: appSecret ?? null,
    channelType,
  });

  await logAction(
    { userId: user.id, tenantId },
    "create_channel_account",
    "channel_account",
    account.id,
    { phoneNumberId, wabaId: wabaId ?? null, channelType },
  );

  return c.json(await present(account), 201);
});

channels.patch("/:id", async (c) => {
  const user = c.get("user");
  const tenantId = activeTenantId(c);
  const id = pathParam(c, "id");

  const account = await ChannelAccountService.getById(id);
  if (
    !account ||
    account.tenant_id !== tenantId ||
    account.channel_type === "simulator"
  ) {
    return c.json({ error: "Channel account not found" }, 404);
  }

  const body = await c.req.json();
  const changed: string[] = [];

  // Every field is validated before the first write, so a refused PATCH leaves
  // the account unchanged. The writes then run in one batch, so a write that
  // fails part way does not leave half of them behind either.
  const malformed = malformedField(body, [
    "accessToken",
    "verifyToken",
    "appSecret",
    "status",
  ]);
  if (malformed) {
    return c.json({ error: `${malformed} must be a string` }, 400);
  }

  if (body.accessToken || body.verifyToken || body.appSecret) {
    if (!isEncryptionAvailable()) {
      return c.json(
        {
          error:
            "SECRETS_KEY is not configured; credentials cannot be stored encrypted",
        },
        503,
      );
    }
  }

  if (body.status && !["active", "pending", "disabled"].includes(body.status)) {
    return c.json({ error: "Invalid status" }, 400);
  }

  // The webhook accepts inbound messages for any active account, and the
  // outbound adapter refuses to send without credentials. An account activated
  // with no access token would receive messages it can never answer. Such an
  // account belongs in 'pending'.
  //
  // The token counts when it is already stored or arrives in this same request.
  if (
    body.status === "active" &&
    !account.access_token_secret_id &&
    !body.accessToken
  ) {
    return c.json(
      {
        error:
          "Cannot activate a channel account with no access token: it would " +
          "receive messages it cannot reply to. Send accessToken with this " +
          "request, or store one first.",
      },
      400,
    );
  }

  await ChannelAccountService.update(account, {
    accessToken: body.accessToken || undefined,
    verifyToken: body.verifyToken || undefined,
    appSecret: body.appSecret || undefined,
    status: body.status || undefined,
  });
  if (body.accessToken) changed.push("access_token");
  if (body.verifyToken) changed.push("verify_token");
  if (body.appSecret) changed.push("app_secret");
  if (body.status) changed.push("status");

  // Handing a pending account its first token activates it, so the status can
  // move without the request naming one. The audit entry records what the
  // account ended up as, not what was asked for.
  const updated = (await ChannelAccountService.getById(id))!;
  if (updated.status !== account.status && !changed.includes("status")) {
    changed.push("status");
  }

  await logAction(
    { userId: user.id, tenantId },
    "update_channel_account",
    "channel_account",
    id,
    { changed, status: updated.status },
  );

  return c.json(await present(updated));
});

export default channels;
