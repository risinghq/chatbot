import { newId } from "@vendeya/utils";
/**
 * Channel accounts: one row per business phone number a tenant messages from.
 * Inbound routing resolves Meta's `metadata.phone_number_id` to an account here.
 * Outbound sends read that account's stored, encrypted credentials.
 */

import { env } from "cloudflare:workers";
import type { ChannelAccount, ChannelType } from "@vendeya/types";
import { batch, getAll, getOne, stmt } from "../../db/index.ts";
import { createLogger } from "../../lib/logger.ts";
import { decryptSecret, encryptSecret } from "../../platform/crypto/secrets.ts";

const logger = createLogger("channel-accounts");

type SecretPurpose = "access_token" | "verify_token" | "app_secret";

/** 32 random bytes as base64url, the token Meta's handshake must echo back. */
function generateVerifyToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

type SecretRow = {
  id: string;
  tenant_id: string;
  purpose: SecretPurpose;
  ciphertext: string;
  iv: string;
  key_id: string;
};

async function insertSecret(
  id: string,
  tenantId: string,
  purpose: SecretPurpose,
  plaintext: string,
): Promise<D1PreparedStatement> {
  const encrypted = await encryptSecret(plaintext);
  return stmt(
    `INSERT INTO channel_secrets (id, tenant_id, purpose, ciphertext, iv, key_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenantId,
      purpose,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.keyId,
    ],
  );
}

/** Decrypt a stored secret, or null if it is missing or unreadable. */
async function readSecret(secretId: string | null): Promise<string | null> {
  if (!secretId) return null;

  const row = await getOne<SecretRow>(
    "SELECT * FROM channel_secrets WHERE id = ?",
    [secretId],
  );
  if (!row) return null;

  try {
    return await decryptSecret({
      ciphertext: row.ciphertext,
      iv: row.iv,
      keyId: row.key_id,
    });
  } catch (error) {
    logger.error({ error, secretId }, "Failed to decrypt channel secret");
    return null;
  }
}

const SECRET_COLUMN = {
  access_token: "access_token_secret_id",
  verify_token: "verify_token_secret_id",
  app_secret: "app_secret_secret_id",
} as const;

/** The statements that store a credential, replacing the one the account has. */
async function secretStatements(
  account: ChannelAccount,
  purpose: SecretPurpose,
  token: string,
): Promise<D1PreparedStatement[]> {
  const existing = account[SECRET_COLUMN[purpose]];
  const encrypted = await encryptSecret(token);
  if (existing) {
    return [
      stmt(
        `UPDATE channel_secrets
         SET ciphertext = ?, iv = ?, key_id = ?, updated_at = unixepoch('now', 'subsec') * 1000
         WHERE id = ? AND tenant_id = ?`,
        [
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.keyId,
          existing,
          account.tenant_id,
        ],
      ),
    ];
  }

  const secretId = newId();
  return [
    stmt(
      `INSERT INTO channel_secrets (id, tenant_id, purpose, ciphertext, iv, key_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        secretId,
        account.tenant_id,
        purpose,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.keyId,
      ],
    ),
    stmt(
      `UPDATE channel_accounts
       SET ${SECRET_COLUMN[purpose]} = ?, updated_at = unixepoch('now', 'subsec') * 1000
       WHERE id = ?`,
      [secretId, account.id],
    ),
  ];
}

export const ChannelAccountService = {
  getById: async (id: string): Promise<ChannelAccount | null> =>
    (await getOne<ChannelAccount>(
      "SELECT * FROM channel_accounts WHERE id = ?",
      [id],
    )) ?? null,

  listForTenant: (tenantId: string): Promise<ChannelAccount[]> =>
    getAll<ChannelAccount>(
      "SELECT * FROM channel_accounts WHERE tenant_id = ? ORDER BY created_at",
      [tenantId],
    ),

  /**
   * An account resolves whatever its status. The webhook logs and rejects
   * messages for an inactive one instead of treating the number as unknown.
   */
  getByPhoneNumberId: async (
    phoneNumberId: string,
    channelType: ChannelType = "whatsapp",
  ): Promise<ChannelAccount | null> =>
    (await getOne<ChannelAccount>(
      "SELECT * FROM channel_accounts WHERE channel_type = ? AND phone_number_id = ?",
      [channelType, phoneNumberId],
    )) ?? null,

  /**
   * The account a tenant sends from when the caller names none. Active accounts
   * come first, then pending, then disabled, oldest first in each.
   */
  getDefaultForTenant: async (
    tenantId: string,
  ): Promise<ChannelAccount | null> =>
    (await getOne<ChannelAccount>(
      `SELECT * FROM channel_accounts
       WHERE tenant_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, created_at
       LIMIT 1`,
      [tenantId],
    )) ?? null,

  /**
   * The account VendeYa's own operations alerts go out on. These alerts belong
   * to the platform, so the account comes from a platform setting, which a
   * platform operator writes, or else from PLATFORM_OPS_PHONE_NUMBER_ID.
   */
  getPlatformOps: async (): Promise<ChannelAccount | null> => {
    const designated =
      (
        await getOne<{ value: string }>(
          "SELECT value FROM system_settings WHERE key = 'platform_ops_channel_account_id'",
        )
      )?.value ?? null;

    if (designated) {
      const account = await ChannelAccountService.getById(designated);
      if (account) return account;

      logger.error(
        { channelAccountId: designated },
        "platform_ops_channel_account_id names an account that does not exist",
      );
    }

    const phoneNumberId = env.PLATFORM_OPS_PHONE_NUMBER_ID;
    return phoneNumberId
      ? ChannelAccountService.getByPhoneNumberId(phoneNumberId)
      : null;
  },

  /** The account and its encrypted credentials are written in one batch. */
  create: async (data: {
    tenantId: string;
    phoneNumberId: string;
    wabaId?: string | null;
    displayPhoneNumber?: string | null;
    label?: string | null;
    accessToken?: string | null;
    appSecret?: string | null;
    verifyToken?: string | null;
    status?: ChannelAccount["status"];
    channelType?: ChannelType;
    id?: string;
  }): Promise<ChannelAccount> => {
    const id = data.id ?? newId();
    const statements: D1PreparedStatement[] = [];

    let accessTokenSecretId: string | null = null;
    if (data.accessToken) {
      accessTokenSecretId = newId();
      statements.push(
        await insertSecret(
          accessTokenSecretId,
          data.tenantId,
          "access_token",
          data.accessToken,
        ),
      );
    }

    // The verify token identifies the number to Meta's handshake. The system
    // generates it: there is nothing for the operator to choose.
    const verifyTokenSecretId = newId();
    statements.push(
      await insertSecret(
        verifyTokenSecretId,
        data.tenantId,
        "verify_token",
        data.verifyToken ?? generateVerifyToken(),
      ),
    );

    let appSecretSecretId: string | null = null;
    if (data.appSecret) {
      appSecretSecretId = newId();
      statements.push(
        await insertSecret(
          appSecretSecretId,
          data.tenantId,
          "app_secret",
          data.appSecret,
        ),
      );
    }

    statements.push(
      stmt(
        `INSERT INTO channel_accounts (
           id, tenant_id, channel_type, waba_id, phone_number_id, display_phone_number,
           label, access_token_secret_id, verify_token_secret_id, app_secret_secret_id, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          data.tenantId,
          data.channelType ?? "whatsapp",
          data.wabaId ?? null,
          data.phoneNumberId,
          data.displayPhoneNumber ?? null,
          data.label ?? null,
          accessTokenSecretId,
          verifyTokenSecretId,
          appSecretSecretId,
          data.status ?? (data.accessToken ? "active" : "pending"),
        ],
      ),
    );

    await batch(statements);
    return (await ChannelAccountService.getById(id))!;
  },

  /**
   * Store new credentials and a new status in one batch. A pending number is
   * waiting for its token, so storing one activates it unless the change names
   * a status. A disabled account stays disabled because disabling is a
   * deliberate decision, not a missing credential.
   */
  update: async (
    account: ChannelAccount,
    change: {
      accessToken?: string;
      verifyToken?: string;
      appSecret?: string;
      status?: ChannelAccount["status"];
    },
  ): Promise<void> => {
    const statements: D1PreparedStatement[] = [];
    if (change.accessToken) {
      statements.push(
        ...(await secretStatements(
          account,
          "access_token",
          change.accessToken,
        )),
      );
    }
    if (change.appSecret) {
      statements.push(
        ...(await secretStatements(account, "app_secret", change.appSecret)),
      );
    }
    if (change.verifyToken) {
      statements.push(
        ...(await secretStatements(
          account,
          "verify_token",
          change.verifyToken,
        )),
      );
    }

    const status =
      change.status ??
      (change.accessToken && account.status === "pending" ? "active" : null);
    if (status) {
      statements.push(
        stmt(
          `UPDATE channel_accounts
           SET status = ?, updated_at = unixepoch('now', 'subsec') * 1000
           WHERE id = ?`,
          [status, account.id],
        ),
      );
    }

    await batch(statements);
  },

  /** Plaintext access token for outbound sends. Never persisted or logged. */
  getAccessToken: (account: ChannelAccount): Promise<string | null> =>
    readSecret(account.access_token_secret_id),

  getVerifyToken: (account: ChannelAccount): Promise<string | null> =>
    readSecret(account.verify_token_secret_id),

  /** The Meta app secret that signs this number's webhook deliveries. */
  getAppSecret: (account: ChannelAccount): Promise<string | null> =>
    readSecret(account.app_secret_secret_id),

  /**
   * Meta's GET verification handshake carries no phone-number id. The caller
   * matches the token against every account listed here.
   */
  listWithVerifyToken: (): Promise<ChannelAccount[]> =>
    getAll<ChannelAccount>(
      "SELECT * FROM channel_accounts WHERE verify_token_secret_id IS NOT NULL",
    ),
};
