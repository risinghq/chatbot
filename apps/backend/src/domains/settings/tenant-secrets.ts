/**
 * Tenant-scoped secrets. A value is AES-256-GCM ciphertext under SECRETS_KEY
 * (platform/crypto/secrets.ts), keyed by (tenant_id, key), and never leaves
 * the server: the settings API reports that one is set, not what it is.
 */

import { batch, getOne, stmt } from "../../db/index.ts";
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
    (await getOne<SecretRow>(
      "SELECT id, ciphertext, iv, key_id FROM tenant_secrets WHERE tenant_id = ? AND key = ?",
      [tenantId, key],
    )) ?? null
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
        stmt(
          `UPDATE tenant_secrets
           SET ciphertext = ?, iv = ?, key_id = ?, updated_at = unixepoch('now', 'subsec') * 1000
           WHERE id = ?`,
          [encrypted.ciphertext, encrypted.iv, encrypted.keyId, existing.id],
        ),
      ]);
      return;
    }

    await batch([
      stmt(
        `INSERT INTO tenant_secrets (id, tenant_id, key, ciphertext, iv, key_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          tenantId,
          key,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.keyId,
        ],
      ),
    ]);
  },

  async clear(tenantId: string, key: string): Promise<void> {
    await batch([
      stmt("DELETE FROM tenant_secrets WHERE tenant_id = ? AND key = ?", [
        tenantId,
        key,
      ]),
    ]);
  },
};
