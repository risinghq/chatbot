import { env } from "cloudflare:workers";
import type { Context, Next } from "hono";

export async function securityHeaders(c: Context, next: Next) {
  await next();

  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("X-XSS-Protection", "1; mode=block");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
}

/**
 * Login attempts per client address, counted by the LOGIN_LIMITER binding so
 * every isolate shares the count. Cloudflare sets `cf-connecting-ip` on every
 * request that reaches the edge. A request without it, such as one in a test,
 * is counted under one shared key.
 */
export async function loginRateLimiter(c: Context, next: Next) {
  const client = c.req.header("cf-connecting-ip") || "unknown";
  const { success } = await env.LOGIN_LIMITER.limit({ key: `login:${client}` });

  if (!success) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  await next();
}
