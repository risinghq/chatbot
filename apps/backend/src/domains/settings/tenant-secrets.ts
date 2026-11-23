import { newId } from "@vendeya/utils";
/**
 * Tenant-scoped secrets. A value is AES-256-GCM ciphertext under SECRETS_KEY
 * (platform/crypto/secrets.ts), keyed by (tenant_id, key), and never leaves
 * the server: the settings API reports that one is set, not what it is.
 */

import { sql } from "kysely";
import { batch, db } from "../../db/index.ts";
import { createLogger } from "../../lib/logger.ts";
import { decryptSecret, encryptSecret } from "../../platform/crypto/secrets.ts";

const logger = createLogger("tenant-secrets");

type SecretRow = {
  id: string;
  ciphertext: string;
  iv: string;
  key_id: string;
};

async function readRow(
  tenantId: string,
  key: string,
): Promise<SecretRow | null> {
  return (
    (await db
      .selectFrom("tenant_secrets")
      .select(["id", "ciphertext", "iv", "key_id"])
      .where("tenant_id", "=", tenantId)
      .where("key", "=", key)
      .executeTakeFirst()) ?? null
  );
}

export const TenantSecrets = {
  /** The plaintext, or null when no secret is stored or it cannot be read. */
  async get(tenantId: string, key: string): Promise<string | null> {
    const row = await readRow(tenantId, key);
    if (!row) return null;

    try {
      return await decryptSecret({
        ciphertext: row.ciphertext,
        iv: row.iv,
        keyId: row.key_id,
      });
    } catch (error) {
      logger.error({ error, tenantId, key }, "Failed to decrypt tenant secret");
      return null;
    }
  },

  async has(tenantId: string, key: string): Promise<boolean> {
    return (await readRow(tenantId, key)) !== null;
  },

  /** Stores the value under (tenant, key), replacing what was there. */
  async set(tenantId: string, key: string, plaintext: string): Promise<void> {
    const encrypted = await encryptSecret(plaintext);
    const existing = await readRow(tenantId, key);

    if (existing) {
      await batch([
        db
          .updateTable("tenant_secrets")
          .set({
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            key_id: encrypted.keyId,
            updated_at: sql`unixepoch('now', 'subsec') * 1000`,
          })
          .where("id", "=", existing.id)
          .where("tenant_id", "=", tenantId),
      ]);
      return;
    }

    await batch([
      db.insertInto("tenant_secrets").values({
        id: newId(),
        tenant_id: tenantId,
        key,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        key_id: encrypted.keyId,
      }),
    ]);
  },

  async clear(tenantId: string, key: string): Promise<void> {
    await batch([
      db
        .deleteFrom("tenant_secrets")
        .where("tenant_id", "=", tenantId)
        .where("key", "=", key),
    ]);
  },
};
