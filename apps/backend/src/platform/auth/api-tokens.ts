import { sql } from "kysely";
import { withoutTenantScope } from "../../db/index.ts";
import { generateSessionToken, sessionIdOf } from "./session.ts";

/** A token is a session row keyed by its hash, listed and revoked by its owner. */
const tokens = () =>
  withoutTenantScope("a token's hash or its owner's user id");

/**
 * API tokens let a program, such as the `vendeya` CLI or an AI agent, act as
 * the person who created them. A token is a session of kind `token`, so it
 * passes the same role, tenant and suspension checks as a browser login. A
 * token made for a business is bound to it; one made without names its
 * business in each request, as a browser does. It never slides: it ends at its expiry, when its
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
 * Creates a token for `userId`, bound to `tenantId` when given. The caller has
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

  await tokens()
    .insertInto("session")
    .values({
      id,
      kind: "token",
      name: request.name,
      user_id: userId,
      active_tenant_id: tenantId,
      expires_at: Math.floor(expiresAt / 1000),
      created_at: now,
      last_used_at: null,
    })
    .execute();

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
  const rows = await tokens()
    .selectFrom("session")
    .select((eb) => [
      "id",
      eb.ref("name").$castTo<string>().as("name"),
      eb.ref("created_at").$castTo<number>().as("created_at"),
      "last_used_at",
      "expires_at",
    ])
    .where("user_id", "=", userId)
    .where("kind", "=", "token")
    .where("expires_at", ">", sql<number>`unixepoch()`)
    .orderBy("created_at", "desc")
    .execute();
  return rows.map((row) => ({ ...row, expires_at: row.expires_at * 1000 }));
}

/** Revokes one of the user's tokens. False when the user has no such token. */
export async function revokeApiToken(
  userId: string,
  tokenId: string,
): Promise<boolean> {
  const result = await tokens()
    .deleteFrom("session")
    .where("id", "=", tokenId)
    .where("user_id", "=", userId)
    .where("kind", "=", "token")
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}
