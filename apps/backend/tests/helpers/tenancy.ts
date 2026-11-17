import type { ConversationRef } from "@vendeya/types";
import { run } from "../../src/db/index.ts";

export type TenantFixture = {
  tenantId: string;
  channelAccountId: string;
  phoneNumberId: string;
  ref(phoneNumber: string): ConversationRef;
};

/**
 * A tenant with one WhatsApp number, ready to hang conversations off. Ids are
 * random per call so the tests of one file never collide in its database. A
 * test that replaces the number sets `channelAccountId`, and `ref` follows it.
 */
export async function createTenantFixture(
  slug: string,
): Promise<TenantFixture> {
  const tenantId = `tn-${crypto.randomUUID()}`;
  const channelAccountId = `ch-${crypto.randomUUID()}`;
  const phoneNumberId = `pnid-${crypto.randomUUID().slice(0, 8)}`;

  await run(
    "INSERT INTO tenants (id, slug, name, status) VALUES (?, ?, ?, 'active')",
    [tenantId, `${slug}-${tenantId.slice(3, 11)}`, slug],
  );
  await run(
    `INSERT INTO channel_accounts (id, tenant_id, channel_type, phone_number_id, status)
     VALUES (?, ?, 'whatsapp', ?, 'active')`,
    [channelAccountId, tenantId, phoneNumberId],
  );

  const fixture: TenantFixture = {
    tenantId,
    channelAccountId,
    phoneNumberId,
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
export async function addChannelAccount(fixture: TenantFixture): Promise<{
  channelAccountId: string;
  phoneNumberId: string;
  ref(phoneNumber: string): ConversationRef;
}> {
  const channelAccountId = `ch-${crypto.randomUUID()}`;
  const phoneNumberId = `pnid-${crypto.randomUUID().slice(0, 8)}`;

  await run(
    `INSERT INTO channel_accounts (id, tenant_id, channel_type, phone_number_id, status)
     VALUES (?, ?, 'whatsapp', ?, 'active')`,
    [channelAccountId, fixture.tenantId, phoneNumberId],
  );

  return {
    channelAccountId,
    phoneNumberId,
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

/** A user with a membership in one tenant, plus the scope they act under. */
export async function createMember(
  fixture: TenantFixture,
  role: "admin" | "developer" | "supervisor" | "sales_agent" = "admin",
) {
  const userId = `u-${crypto.randomUUID()}`;

  await run(
    `INSERT INTO users (id, username, password_hash, role, name)
     VALUES (?, ?, 'x', ?, ?)`,
    [userId, `user-${userId.slice(2, 10)}`, role, "Test User"],
  );
  await run(
    `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
     VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), fixture.tenantId, userId, role],
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
