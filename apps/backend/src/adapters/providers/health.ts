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
 */
function keyOf(provider: ProviderName): string {
  return `breaker:${provider}`;
}

async function blockOf(provider: ProviderName): Promise<Block | null> {
  return env.KV.get<Block>(keyOf(provider), "json");
}

export async function isAvailable(provider: ProviderName): Promise<boolean> {
  const block = await blockOf(provider);
  return !block || block.blockedUntil <= Date.now();
}

export async function markBlocked(
  provider: ProviderName,
  errorMsg: string,
): Promise<void> {
  const wasHealthy = await isAvailable(provider);
  const block: Block = {
    lastError: errorMsg,
    blockedUntil: Date.now() + BLOCK_DURATION_S * 1000,
  };
  await env.KV.put(keyOf(provider), JSON.stringify(block), {
    expirationTtl: BLOCK_DURATION_S,
  });

  if (wasHealthy) {
    logger.error(
      {
        provider,
        errorMsg,
        blockedUntil: new Date(block.blockedUntil).toISOString(),
      },
      "Provider blocked for 30 minutes",
    );
  }
}

export async function getStatus(provider: ProviderName) {
  const block = await blockOf(provider);
  const blocked = !!block && block.blockedUntil > Date.now();
  return {
    status: blocked ? "blocked" : "healthy",
    available: !blocked,
    lastError: blocked ? block.lastError : null,
    blockedUntil: blocked ? new Date(block.blockedUntil).toISOString() : null,
  };
}

export async function getAllStatus() {
  const [fnb, gaso, powerbi] = await Promise.all(PROVIDERS.map(getStatus));
  return { fnb: fnb!, gaso: gaso!, powerbi: powerbi! };
}
