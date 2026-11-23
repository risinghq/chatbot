import { newId } from "@vendeya/utils";
/**
 * Channel accounts: one row per business phone number a tenant messages from.
 * Inbound routing resolves Meta's `metadata.phone_number_id` to an account here.
 * Outbound sends read that account's stored, encrypted credentials.
 */

import { env } from "cloudflare:workers";
import type { ChannelAccount, ChannelType } from "@vendeya/types";
import { type Compilable, sql } from "kysely";
import { batch, db, withoutTenantScope } from "../../db/index.ts";
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

const NOW_MS = sql<number>`unixepoch('now', 'subsec') * 1000`;

function insertSecret(
  id: string,
  tenantId: string,
  purpose: SecretPurpose,
  plaintext: string,
): Promise<Compilable> {
  return encryptSecret(plaintext).then((encrypted) =>
    db.insertInto("channel_secrets").values({
      id,
      tenant_id: tenantId,
      purpose,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      key_id: encrypted.keyId,
    }),
  );
}

/** Decrypt a stored secret, or null if it is missing or unreadable. */
async function readSecret(secretId: string | null): Promise<string | null> {
  if (!secretId) return null;

  const row = await withoutTenantScope("channel secret keyed by its own id")
    .selectFrom("channel_secrets")
    .selectAll()
    .where("id", "=", secretId)
    .executeTakeFirst();
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
): Promise<Compilable[]> {
  const existing = account[SECRET_COLUMN[purpose]];
  const encrypted = await encryptSecret(token);
  if (existing) {
    return [
      db
        .updateTable("channel_secrets")
        .set({
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          key_id: encrypted.keyId,
          updated_at: NOW_MS,
        })
        .where("id", "=", existing)
        .where("tenant_id", "=", account.tenant_id),
    ];
  }

  const secretId = newId();
  return [
    db.insertInto("channel_secrets").values({
      id: secretId,
      tenant_id: account.tenant_id,
      purpose,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      key_id: encrypted.keyId,
    }),
    db
      .updateTable("channel_accounts")
      .set({ [SECRET_COLUMN[purpose]]: secretId, updated_at: NOW_MS })
      .where("id", "=", account.id)
      .where("tenant_id", "=", account.tenant_id),
  ];
}

export const ChannelAccountService = {
  getById: async (id: string): Promise<ChannelAccount | null> =>
    (await withoutTenantScope("channel account keyed by its own id")
      .selectFrom("channel_accounts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) ?? null,

  /** The tenant's WhatsApp numbers. The simulator channel is not one. */
  listForTenant: (tenantId: string): Promise<ChannelAccount[]> =>
    db
      .selectFrom("channel_accounts")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("channel_type", "=", "whatsapp")
      .orderBy("created_at")
      .execute(),

  /**
   * The tenant's simulator channel, created on first use. It holds no
   * credentials and nothing is ever sent on it, so a business can try its
   * assistant before it connects a number.
   */
  simulatorFor: async (tenantId: string): Promise<ChannelAccount> => {
    await db
      .insertInto("channel_accounts")
      .values({
        id: newId(),
        tenant_id: tenantId,
        channel_type: "simulator",
        phone_number_id: tenantId,
        label: "Simulador",
        status: "active",
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    return (await ChannelAccountService.getByPhoneNumberId(
      tenantId,
      "simulator",
    ))!;
  },

  /**
   * An account resolves whatever its status. The webhook logs and rejects
   * messages for an inactive one instead of treating the number as unknown.
   */
  getByPhoneNumberId: async (
    phoneNumberId: string,
    channelType: ChannelType = "whatsapp",
  ): Promise<ChannelAccount | null> =>
    (await withoutTenantScope("a phone number id is unique across tenants")
      .selectFrom("channel_accounts")
      .selectAll()
      .where("channel_type", "=", channelType)
      .where("phone_number_id", "=", phoneNumberId)
      .executeTakeFirst()) ?? null,

  /**
   * The account a tenant sends from when the caller names none. Active accounts
   * come first, then pending, then disabled, oldest first in each.
   */
  getDefaultForTenant: async (
    tenantId: string,
  ): Promise<ChannelAccount | null> =>
    (await db
      .selectFrom("channel_accounts")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("channel_type", "=", "whatsapp")
      .orderBy((eb) =>
        eb
          .case()
          .when("status", "=", "active")
          .then(0)
          .when("status", "=", "pending")
          .then(1)
          .else(2)
          .end(),
      )
      .orderBy("created_at")
      .limit(1)
      .executeTakeFirst()) ?? null,

  /**
   * The account VendeYa's own operations alerts go out on. These alerts belong
   * to the platform, so the account comes from a platform setting, which a
   * platform operator writes, or else from PLATFORM_OPS_PHONE_NUMBER_ID.
   */
  getPlatformOps: async (): Promise<ChannelAccount | null> => {
    const designated =
      (
        await db
          .selectFrom("system_settings")
          .select("value")
          .where("key", "=", "platform_ops_channel_account_id")
          .executeTakeFirst()
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
    const statements: Compilable[] = [];

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
      db.insertInto("channel_accounts").values({
        id,
        tenant_id: data.tenantId,
        channel_type: data.channelType ?? "whatsapp",
        waba_id: data.wabaId ?? null,
        phone_number_id: data.phoneNumberId,
        display_phone_number: data.displayPhoneNumber ?? null,
        label: data.label ?? null,
        access_token_secret_id: accessTokenSecretId,
        verify_token_secret_id: verifyTokenSecretId,
        app_secret_secret_id: appSecretSecretId,
        status: data.status ?? (data.accessToken ? "active" : "pending"),
      }),
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
    const statements: Compilable[] = [];
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
        db
          .updateTable("channel_accounts")
          .set({ status, updated_at: NOW_MS })
          .where("id", "=", account.id)
          .where("tenant_id", "=", account.tenant_id),
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
    withoutTenantScope("Meta's verify handshake carries no tenant")
      .selectFrom("channel_accounts")
      .selectAll()
      .where("verify_token_secret_id", "is not", null)
      .execute(),
};
