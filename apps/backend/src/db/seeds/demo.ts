import { ChannelAccountService } from "../../domains/channels/accounts.ts";
import { TenantService } from "../../domains/tenants/index.ts";
import { isEncryptionAvailable } from "../../platform/crypto/secrets.ts";
import { createLogger } from "../../lib/logger.ts";
import type { ChannelAccount, Tenant } from "@vendeya/types";

const logger = createLogger("seed-demo");

export const DEMO_BUSINESS_NAME = "Tienda demo";

/** The business to load the demo into: the one named, or a new one. */
export async function demoBusiness(tenantId?: string): Promise<Tenant> {
  if (!tenantId) return TenantService.create({ name: DEMO_BUSINESS_NAME });

  const tenant = await TenantService.getById(tenantId);
  if (!tenant) throw new Error(`No tenant has the id ${tenantId}.`);
  return tenant;
}

/**
 * A pending number that never reaches Meta, so the sample conversations have
 * a channel to belong to. `phone_number_id` is unique across tenants, so the
 * placeholder names its tenant.
 */
export async function demoChannelAccount(
  tenantId: string,
): Promise<ChannelAccount | null> {
  const phoneNumberId = `demo:${tenantId}`;
  const existing =
    await ChannelAccountService.getByPhoneNumberId(phoneNumberId);
  if (existing) return existing;

  // Every channel account stores an encrypted verify token, so without
  // SECRETS_KEY no account can exist.
  if (!isEncryptionAvailable()) {
    logger.warn(
      "SECRETS_KEY is not set: the demo number and its sample conversations " +
        "were skipped. Set SECRETS_KEY in .dev.vars and re-run the seed.",
    );
    return null;
  }

  return ChannelAccountService.create({
    tenantId,
    phoneNumberId,
    label: "Número demo",
    status: "pending",
  });
}
