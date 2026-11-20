import type { ConversationRef } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { run } from "../../src/db/index.ts";
import { ChannelAccountService } from "../../src/domains/channels/accounts.ts";
import { TenantSecrets } from "../../src/domains/settings/tenant-secrets.ts";
import {
  SystemSettings,
  TenantSettings,
} from "../../src/domains/settings/system.ts";

/** The app secret every fixture number signs with, unless a test sets another. */
export const TEST_APP_SECRET = "test-meta-app-secret";

export type TenantFixture = {
  tenantId: string;
  channelAccountId: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: () => Promise<string | null>;
  ref(phoneNumber: string): ConversationRef;
};

/**
 * A tenant with one WhatsApp number, ready to hang conversations off. Ids are
 * random per call so the tests of one file never collide in its database. A
 * test that replaces the number sets `channelAccountId`, and `ref` follows it.
 */
export async function createTenantFixture(
  name: string,
): Promise<TenantFixture> {
  const tenantId = await insertTenant(name);
  const channelAccountId = newId();
  const phoneNumberId = `pnid-${crypto.randomUUID().slice(0, 8)}`;

  const account = await ChannelAccountService.create({
    id: channelAccountId,
    tenantId,
    phoneNumberId,
    accessToken: "test-access-token",
    appSecret: TEST_APP_SECRET,
    status: "active",
  });

  const fixture: TenantFixture = {
    tenantId,
    channelAccountId,
    phoneNumberId,
    appSecret: TEST_APP_SECRET,
    verifyToken: async () =>
      ChannelAccountService.getVerifyToken(
        (await ChannelAccountService.getById(channelAccountId)) ?? account,
      ),
    ref: (phoneNumber: string) => ({
      tenantId,
      channelAccountId: fixture.channelAccountId,
      phoneNumber,
    }),
  };
  return fixture;
}

/**
 * A second WhatsApp number for the same tenant. One contact writing to both is
 * two conversations, which is what the ambiguity guards are about.
 */
export async function addChannelAccount(
  fixture: TenantFixture,
  options: { appSecret?: string } = {},
): Promise<{
  channelAccountId: string;
  phoneNumberId: string;
  appSecret: string;
  ref(phoneNumber: string): ConversationRef;
}> {
  const channelAccountId = newId();
  const phoneNumberId = `pnid-${crypto.randomUUID().slice(0, 8)}`;
  const appSecret = options.appSecret ?? TEST_APP_SECRET;

  await ChannelAccountService.create({
    id: channelAccountId,
    tenantId: fixture.tenantId,
    phoneNumberId,
    accessToken: "test-access-token",
    appSecret,
    status: "active",
  });

  return {
    channelAccountId,
    phoneNumberId,
    appSecret,
    ref: (phoneNumber: string) => ({
      tenantId: fixture.tenantId,
      channelAccountId,
      phoneNumber,
    }),
  };
}

/** Insert a conversation row directly, bypassing the handler. */
export async function insertConversation(
  ref: ConversationRef,
  overrides: {
    contextData?: unknown;
    status?: string;
    clientName?: string | null;
    assignedAgent?: string | null;
    isSimulation?: boolean;
  } = {},
): Promise<void> {
  await run(
    `INSERT INTO conversations
       (tenant_id, channel_account_id, phone_number, context_data, status, client_name, assigned_agent, is_simulation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ref.tenantId,
      ref.channelAccountId,
      ref.phoneNumber,
      JSON.stringify(
        overrides.contextData ?? {
          phase: { phase: "greeting" },
          metadata: { createdAt: Date.now(), lastActivityAt: Date.now() },
        },
      ),
      overrides.status ?? "active",
      overrides.clientName ?? null,
      overrides.assignedAgent ?? null,
      overrides.isSimulation ? 1 : 0,
    ],
  );
}

/** An active tenant with no number. Returns its id. */
export async function insertTenant(name = "Test Business"): Promise<string> {
  const tenantId = newId();
  await run("INSERT INTO tenants (id, name, status) VALUES (?, ?, 'active')", [
    tenantId,
    name,
  ]);
  return tenantId;
}

/**
 * A user with no membership and a password nobody can log in with. Returns
 * its id; the email is `<id>@test.invalid`.
 */
export async function insertUser(
  options: { name?: string; isPlatformOperator?: boolean } = {},
): Promise<string> {
  const userId = newId();
  await run(
    `INSERT INTO users (id, email, password_hash, name, is_platform_operator)
     VALUES (?, ?, 'x', ?, ?)`,
    [
      userId,
      `${userId}@test.invalid`,
      options.name ?? "Test User",
      options.isPlatformOperator ? 1 : 0,
    ],
  );
  return userId;
}

/** A user with a membership in one tenant, plus the scope they act under. */
export async function createMember(
  fixture: Pick<TenantFixture, "tenantId">,
  role: "admin" | "developer" | "supervisor" | "sales_agent" = "admin",
) {
  const userId = await insertUser();
  await run(
    `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
     VALUES (?, ?, ?, ?)`,
    [newId(), fixture.tenantId, userId, role],
  );

  return {
    userId,
    scope: {
      userId,
      tenantId: fixture.tenantId,
      membershipRole: role,
      isPlatformOperator: false,
    } as const,
  };
}

/**
 * A Cálidda login for the tenant, stored the way the settings route stores it:
 * the username in `tenant_settings`, the password in `tenant_secrets`.
 */
export async function setCaliddaLogin(
  tenantId: string,
  login: { username?: string; password?: string } = {},
): Promise<void> {
  await TenantSettings.set(
    tenantId,
    "calidda_username",
    login.username ?? "test-user",
  );
  await TenantSecrets.set(
    tenantId,
    "calidda_password",
    login.password ?? "test-password",
  );
}

/** The four ids of the platform's Power BI report, as an operator saves them. */
export async function setPowerBIReport(
  ids: {
    resourceKey?: string;
    reportId?: string;
    datasetId?: string;
    modelId?: string;
  } = {},
): Promise<void> {
  await SystemSettings.set(
    "powerbi_resource_key",
    ids.resourceKey ?? "test-resource-key",
  );
  await SystemSettings.set("powerbi_report_id", ids.reportId ?? "test-report");
  await SystemSettings.set(
    "powerbi_dataset_id",
    ids.datasetId ?? "test-dataset",
  );
  await SystemSettings.set("powerbi_model_id", ids.modelId ?? "1");
}

/** Parks a number in a status, the way an operator's PATCH would. */
export async function setChannelStatus(
  channelAccountId: string,
  status: "active" | "pending" | "disabled",
): Promise<void> {
  await run("UPDATE channel_accounts SET status = ? WHERE id = ?", [
    status,
    channelAccountId,
  ]);
}
