import { getAll, run } from "../../db/index.ts";
import { generateSessionToken, sessionIdOf } from "./session.ts";

/**
 * API tokens let a program, such as the `vendeya` CLI or an AI agent, act as
 * the person who created them. A token is a session of kind `token`, so it
 * passes the same role, tenant and suspension checks as a browser login and
 * pins a tenant the same way. It never slides: it ends at its expiry, when its
 * owner revokes it, or when its owner changes their password.
 */

/** Marks a string as a VendeYa token, so a leaked one is easy to recognise. */
export const API_TOKEN_PREFIX = "vy_";

export const DEFAULT_TOKEN_DAYS = 90;
export const MAX_TOKEN_DAYS = 365;

const DAY_MS = 1000 * 60 * 60 * 24;

export type ApiToken = {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
};

export type NewApiToken = ApiToken & { token: string };

export type TokenRequestProblem = { problem: string };

/** Checks a requested name and lifetime before anything is written. */
export function checkTokenRequest(input: {
  name: unknown;
  days?: unknown;
}): { name: string; days: number } | TokenRequestProblem {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { problem: "A token needs a name." };
  if (name.length > 80)
    return { problem: "The name is longer than 80 characters." };

  const days = input.days ?? DEFAULT_TOKEN_DAYS;
  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > MAX_TOKEN_DAYS
  ) {
    return {
      problem: `Days must be a whole number from 1 to ${MAX_TOKEN_DAYS}.`,
    };
  }
  return { name, days };
}

/**
 * Creates a token for `userId`, pinned to `tenantId` when given. The caller has
 * checked the user may act in that tenant. The plain token is returned once;
 * only its hash is stored.
 */
export async function createApiToken(
  userId: string,
  request: { name: string; days: number },
  tenantId: string | null,
): Promise<NewApiToken> {
  const token = API_TOKEN_PREFIX + generateSessionToken();
  const now = Date.now();
  const expiresAt = now + request.days * DAY_MS;
  const id = sessionIdOf(token);

  await run(
    `INSERT INTO session (id, kind, name, user_id, active_tenant_id, expires_at, created_at)
     VALUES (?, 'token', ?, ?, ?, ?, ?)`,
    [id, request.name, userId, tenantId, Math.floor(expiresAt / 1000), now],
  );

  return {
    id,
    name: request.name,
    created_at: now,
    last_used_at: null,
    expires_at: expiresAt,
    token,
  };
}

/** The user's live tokens, newest first. Expired ones are not listed. */
export async function listApiTokens(userId: string): Promise<ApiToken[]> {
  const rows = await getAll<{
    id: string;
    name: string;
    created_at: number;
    last_used_at: number | null;
    expires_at: number;
  }>(
    `SELECT id, name, created_at, last_used_at, expires_at FROM session
     WHERE user_id = ? AND kind = 'token' AND expires_at > unixepoch()
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((row) => ({ ...row, expires_at: row.expires_at * 1000 }));
}

/** Revokes one of the user's tokens. False when the user has no such token. */
export async function revokeApiToken(
  userId: string,
  tokenId: string,
): Promise<boolean> {
  const result = await run(
    "DELETE FROM session WHERE id = ? AND user_id = ? AND kind = 'token'",
    [tokenId, userId],
  );
  return result.changes > 0;
}
