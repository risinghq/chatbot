import { env } from "cloudflare:workers";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger("providers");

export type ProviderName = "fnb" | "gaso" | "powerbi";

const PROVIDERS: ProviderName[] = ["fnb", "gaso", "powerbi"];

/** How long a provider that failed is left alone before it is tried again. */
const BLOCK_DURATION_S = 30 * 60;

type Block = { lastError: string; blockedUntil: number };

/**
 * The breaker lives in KV, so every isolate sees a block. A block is a key
 * that expires when the block ends, and a missing key means healthy. KV takes
 * up to a minute to show a write everywhere, so an isolate elsewhere may try a
 * provider once more after it was blocked.
 *
 * FNB fails on a tenant's own Cálidda login, so its block is per tenant and
 * one business's bad password never blocks another's checks. The other
 * providers are platform integrations and block for everyone.
 */
function keyOf(provider: ProviderName, tenantId?: string): string {
  return tenantId ? `breaker:${provider}:${tenantId}` : `breaker:${provider}`;
}

async function blockOf(
  provider: ProviderName,
  tenantId?: string,
): Promise<Block | null> {
  return env.KV.get<Block>(keyOf(provider, tenantId), "json");
}

export async function isAvailable(
  provider: ProviderName,
  tenantId?: string,
): Promise<boolean> {
  const block = await blockOf(provider, tenantId);
  return !block || block.blockedUntil <= Date.now();
}

/**
 * Lifts a block, so a fixed cause (a corrected Cálidda password) does not keep
 * the tenant's checks failing until the key expires.
 */
export async function clearBlock(
  provider: ProviderName,
  tenantId?: string,
): Promise<void> {
  await env.KV.delete(keyOf(provider, tenantId));
}

export async function markBlocked(
  provider: ProviderName,
  errorMsg: string,
  tenantId?: string,
): Promise<void> {
  const wasHealthy = await isAvailable(provider, tenantId);
  const block: Block = {
    lastError: errorMsg,
    blockedUntil: Date.now() + BLOCK_DURATION_S * 1000,
  };
  await env.KV.put(keyOf(provider, tenantId), JSON.stringify(block), {
    expirationTtl: BLOCK_DURATION_S,
  });

  if (wasHealthy) {
    logger.error(
      {
        provider,
        tenantId,
        errorMsg,
        blockedUntil: new Date(block.blockedUntil).toISOString(),
      },
      "Provider blocked for 30 minutes",
    );
  }
}

/**
 * FNB blocks are per tenant, so a read without a tenant cannot call FNB
 * healthy or blocked — it reports `per-tenant` instead of a lie.
 */
export async function getStatus(provider: ProviderName, tenantId?: string) {
  if (provider === "fnb" && !tenantId) {
    return {
      status: "per-tenant" as const,
      available: null,
      lastError: null,
      blockedUntil: null,
    };
  }
  const block = await blockOf(
    provider,
    provider === "fnb" ? tenantId : undefined,
  );
  const blocked = !!block && block.blockedUntil > Date.now();
  return {
    status: blocked ? ("blocked" as const) : ("healthy" as const),
    available: !blocked,
    lastError: blocked ? block.lastError : null,
    blockedUntil: blocked ? new Date(block.blockedUntil).toISOString() : null,
  };
}

export async function getAllStatus(tenantId?: string) {
  const [fnb, gaso, powerbi] = await Promise.all(
    PROVIDERS.map((provider) => getStatus(provider, tenantId)),
  );
  return { fnb: fnb!, gaso: gaso!, powerbi: powerbi! };
}
