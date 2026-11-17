import { env } from "cloudflare:workers";
import { ChannelAccountService } from "../../domains/channels/accounts.ts";
import { TenantService } from "../../domains/tenants/index.ts";
import { isEncryptionAvailable } from "../../platform/crypto/secrets.ts";
import { createLogger } from "../../lib/logger.ts";
import type { ChannelAccount, Tenant } from "@vendeya/types";
import {
  DEFAULT_TENANT_NAME,
  DEFAULT_TENANT_SLUG,
  unconfiguredPhoneNumberId,
} from "./tenant-defaults.ts";

const logger = createLogger("seed-tenants");

/**
 * Seed-only values from .dev.vars. The Worker never reads them: after the
 * seed, the number and its token live on the channel account.
 */
function seedVar(
  name:
    | "WHATSAPP_PHONE_ID"
    | "WHATSAPP_TOKEN"
    | "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
): string | null {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : null;
}

export async function ensureDefaultTenant(): Promise<Tenant> {
  return (
    (await TenantService.getBySlug(DEFAULT_TENANT_SLUG)) ??
    (await TenantService.create({
      slug: DEFAULT_TENANT_SLUG,
      name: DEFAULT_TENANT_NAME,
    }))
  );
}

/**
 * Creates the channel account for a tenant from the WHATSAPP_* seed values,
 * or imports the credentials that an existing one is missing. Nothing else
 * imports those credentials.
 */
export async function ensureChannelAccountFromEnv(
  tenantId: string,
): Promise<ChannelAccount> {
  const configured = seedVar("WHATSAPP_PHONE_ID");
  const phoneNumberId = await seededPhoneNumberId(configured, tenantId);

  // The WHATSAPP_* credentials belong to the configured number, so they are
  // only imported onto that number and never onto a placeholder.
  const usesConfiguredNumber = phoneNumberId === configured;
  const accessToken = usesConfiguredNumber ? seedVar("WHATSAPP_TOKEN") : null;
  const verifyToken = usesConfiguredNumber
    ? seedVar("WHATSAPP_WEBHOOK_VERIFY_TOKEN")
    : null;
  const canEncrypt = isEncryptionAvailable();

  const existing =
    await ChannelAccountService.getByPhoneNumberId(phoneNumberId);

  if (existing) {
    if (existing.tenant_id !== tenantId) {
      throw new Error(
        `Channel account ${existing.id} holds phone-number id ${phoneNumberId}, ` +
          `which is reserved for tenant ${tenantId}'s placeholder number`,
      );
    }

    // Seeding a number that already exists imports only the credentials it is
    // missing. Setting SECRETS_KEY and re-running the seed therefore turns a
    // pending account into one that can send.
    const needsAccessToken =
      accessToken !== null && existing.access_token_secret_id === null;
    const needsVerifyToken =
      verifyToken !== null && existing.verify_token_secret_id === null;

    // The environment variables are the initial import, not the source of
    // truth. A token rotated through PATCH /api/admin/channels/:id must
    // survive the next seed.
    if (!needsAccessToken && !needsVerifyToken) return existing;

    if (!canEncrypt) {
      warnAboutMissingKey();
      return existing;
    }

    const change = {
      ...(accessToken && needsAccessToken && { accessToken }),
      ...(verifyToken && needsVerifyToken && { verifyToken }),
    };
    await ChannelAccountService.update(existing, change);
    const imported = [
      ...("accessToken" in change ? ["access_token"] : []),
      ...("verifyToken" in change ? ["verify_token"] : []),
    ];

    const updated =
      (await ChannelAccountService.getById(existing.id)) ?? existing;

    logger.info(
      {
        channelAccountId: updated.id,
        tenantId,
        phoneNumberId,
        status: updated.status,
        imported,
      },
      "Imported channel account credentials",
    );

    return updated;
  }

  if ((accessToken || verifyToken) && !canEncrypt) {
    warnAboutMissingKey();
  }

  // Tokens are stored encrypted. Without a key the account is created without
  // them and left 'pending', which is the right state for a number that cannot
  // send yet.
  const storeCredentials = canEncrypt;

  const account = await ChannelAccountService.create({
    tenantId,
    phoneNumberId,
    label: DEFAULT_TENANT_NAME,
    accessToken: storeCredentials ? accessToken : null,
    verifyToken: storeCredentials ? verifyToken : null,
    status: storeCredentials && accessToken ? "active" : "pending",
  });

  logger.info(
    {
      channelAccountId: account.id,
      tenantId,
      phoneNumberId,
      status: account.status,
    },
    "Seeded channel account",
  );

  return account;
}

/**
 * WHATSAPP_PHONE_ID when it is set and free for this tenant, otherwise this
 * tenant's placeholder.
 */
async function seededPhoneNumberId(
  configured: string | null,
  tenantId: string,
): Promise<string> {
  if (!configured) return unconfiguredPhoneNumberId(tenantId);

  // A configured number registered to another tenant belongs to that tenant.
  // Handing it out would put this tenant's rows on another business's number.
  const owner = await ChannelAccountService.getByPhoneNumberId(configured);
  if (!owner || owner.tenant_id === tenantId) return configured;

  logger.error(
    { phoneNumberId: configured, tenantId, ownerTenantId: owner.tenant_id },
    "WHATSAPP_PHONE_ID is registered to another tenant; seeding this tenant " +
      "a pending placeholder number instead",
  );
  return unconfiguredPhoneNumberId(tenantId);
}

function warnAboutMissingKey(): void {
  logger.warn(
    "SECRETS_KEY is not set: seeding the channel account without credentials. " +
      "Set SECRETS_KEY in .dev.vars and re-run the seed, or add the token " +
      "on the dashboard, before sending on this number.",
  );
}

/** The default tenant and its one channel account, created if absent. */
export async function seedTenants(): Promise<{
  tenant: Tenant;
  channelAccount: ChannelAccount;
}> {
  const tenant = await ensureDefaultTenant();
  const channelAccount = await ensureChannelAccountFromEnv(tenant.id);

  return { tenant, channelAccount };
}
