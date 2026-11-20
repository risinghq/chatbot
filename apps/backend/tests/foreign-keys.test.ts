/**
 * D1 enforces foreign keys on every connection. These tests check that the
 * schema's REFERENCES and ON DELETE CASCADE rules hold the rows they should.
 */

import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

import { getOne, run } from "../src/db/index.ts";
import {
  addChannelAccount,
  createTenantFixture,
  fileOrder,
  insertConversation,
  insertUser,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import tenantRoutes from "../src/routes/tenants.ts";
import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";
import { webhookRequest } from "./helpers/turn.ts";
import { signedWebhookRequest } from "./helpers/webhook.ts";

describe("foreign key enforcement", () => {
  let tenant: TenantFixture;

  beforeEach(async () => {
    tenant = await createTenantFixture("fk");
  });

  it("rejects a membership for a user that does not exist", async () => {
    await expect(
      run(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
           VALUES (?, ?, 'no-such-user', 'admin')`,
        [crypto.randomUUID(), tenant.tenantId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a membership for a tenant that does not exist", async () => {
    const userId = await insertUser();

    await expect(
      run(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
           VALUES (?, 'no-such-tenant', ?, 'admin')`,
        [crypto.randomUUID(), userId],
      ),
    ).rejects.toThrow();

    await run("DELETE FROM users WHERE id = ?", [userId]);
  });

  it("rejects a conversation on a channel account that does not exist", async () => {
    await expect(
      insertConversation({
        tenantId: tenant.tenantId,
        channelAccountId: "no-such-channel",
        phoneNumber: "51900000000",
      }),
    ).rejects.toThrow();
  });

  it("rejects a message with no conversation behind it", async () => {
    await expect(
      MessageStore.log(tenant.ref("51900000001"), "inbound", "text", "hola"),
    ).rejects.toThrow();
  });

  // Every table carrying both columns must reference the pair together, not
  // each one independently, so a mismatch is a constraint failure.
  describe("a tenant paired with another tenant's number", () => {
    let other: TenantFixture;

    beforeEach(async () => {
      other = await createTenantFixture("fk-other");
    });

    it("is refused on a conversation", async () => {
      await expect(
        insertConversation({
          tenantId: tenant.tenantId,
          channelAccountId: other.channelAccountId,
          phoneNumber: "51900000010",
        }),
      ).rejects.toThrow();
    });

    /**
     * The tables that carry the pair without a conversation row in between, so
     * the composite key on `channel_accounts` is the only thing checking them.
     * Each builds its statement from a (tenant, channel account) pair.
     */
    const pairedTables: Array<{
      table: string;
      insert: (tenantId: string, channelAccountId: string) => Promise<unknown>;
    }> = [
      {
        table: "message_inbox",
        insert: async (tenantId, channelAccountId) =>
          await run(
            `INSERT INTO message_inbox
                 (tenant_id, channel_account_id, phone_number, message_text, message_id, whatsapp_timestamp)
               VALUES (?, ?, '51900000011', 'hola', ?, 1)`,
            [tenantId, channelAccountId, crypto.randomUUID()],
          ),
      },
      {
        table: "analytics_events",
        insert: async (tenantId, channelAccountId) =>
          await run(
            `INSERT INTO analytics_events
                 (id, tenant_id, channel_account_id, phone_number, event_type)
               VALUES (?, ?, ?, '51900000013', 'message_received')`,
            [crypto.randomUUID(), tenantId, channelAccountId],
          ),
      },
      {
        table: "llm_calls",
        insert: async (tenantId, channelAccountId) =>
          await run(
            `INSERT INTO llm_calls
                 (id, tenant_id, channel_account_id, phone_number, operation, model, prompt, user_message, status)
               VALUES (?, ?, ?, '51900000014', 'classify', 'gpt', 'p', 'u', 'success')`,
            [crypto.randomUUID(), tenantId, channelAccountId],
          ),
      },
    ];

    for (const { table, insert } of pairedTables) {
      it(`is refused on ${table}`, async () => {
        await expect(
          insert(tenant.tenantId, other.channelAccountId),
        ).rejects.toThrow();
      });

      it(`still accepts ${table} when the pair matches`, async () => {
        await expect(
          insert(tenant.tenantId, tenant.channelAccountId),
        ).resolves.not.toThrow();
      });
    }

    it("is refused on a message, even with a conversation of its own", async () => {
      // A conversation with this phone number exists under the other tenant.
      // The message still pairs this tenant with the other tenant's number.
      await insertConversation(other.ref("51900000015"));

      await expect(
        run(
          `INSERT INTO messages
               (id, tenant_id, channel_account_id, phone_number, direction, type, content)
             VALUES (?, ?, ?, '51900000015', 'inbound', 'text', 'hola')`,
          [crypto.randomUUID(), tenant.tenantId, other.channelAccountId],
        ),
      ).rejects.toThrow();
    });

    it("is refused on an order", async () => {
      await expect(
        fileOrder({
          tenantId: tenant.tenantId,
          channelAccountId: other.channelAccountId,
          phoneNumber: "51900000016",
        }),
      ).rejects.toThrow();
    });
  });

  /**
   * The database rejects a bundle that names one tenant while its period
   * belongs to another. The route checks this too, but a check in one handler
   * is not a constraint.
   */
  describe("a bundle in another tenant's period", () => {
    let other: TenantFixture;

    beforeEach(async () => {
      other = await createTenantFixture("fk-period");
    });

    async function createPeriod(
      tenantId: string,
      yearMonth: string,
    ): Promise<string> {
      const id = `per-${crypto.randomUUID()}`;
      await run(
        `INSERT INTO catalog_periods (id, tenant_id, name, year_month)
         VALUES (?, ?, 'Septiembre', ?)`,
        [id, tenantId, yearMonth],
      );
      return id;
    }

    async function insertBundle(
      tenantId: string,
      periodId: string,
    ): Promise<void> {
      await run(
        `INSERT INTO catalog_bundles
           (id, tenant_id, period_id, segment, name, price, primary_category,
            image_id, composition_json, installments_json)
         VALUES (?, ?, ?, 'gaso', 'Combo', 999, 'cocinas', 'img-1', '[]', '[]')`,
        [`bundle-${crypto.randomUUID()}`, tenantId, periodId],
      );
    }

    it("is refused", async () => {
      const theirPeriod = await createPeriod(other.tenantId, "2026-09");

      await expect(
        insertBundle(tenant.tenantId, theirPeriod),
      ).rejects.toThrow();
    });

    it("is still accepted when the period is the tenant's own", async () => {
      const ownPeriod = await createPeriod(tenant.tenantId, "2026-09");

      await expect(
        insertBundle(tenant.tenantId, ownPeriod),
      ).resolves.not.toThrow();
    });

    it("cascades a period delete to the bundles in it", async () => {
      const period = await createPeriod(tenant.tenantId, "2026-10");
      await insertBundle(tenant.tenantId, period);

      await run("DELETE FROM catalog_periods WHERE id = ?", [period]);

      expect(
        await getOne(
          "SELECT COUNT(*) as count FROM catalog_bundles WHERE period_id = ?",
          [period],
        ),
      ).toEqual({ count: 0 });
    });
  });

  it("cascades a tenant delete through its children", async () => {
    const scratch = await createTenantFixture("fk-cascade");
    const ref = scratch.ref("51900000002");
    await insertConversation(ref);
    await MessageStore.log(ref, "inbound", "text", "hola");

    expect(await MessageStore.getHistory(ref)).toHaveLength(1);

    await run("DELETE FROM tenants WHERE id = ?", [scratch.tenantId]);

    expect(
      await getOne(
        "SELECT COUNT(*) as c FROM conversations WHERE tenant_id = ?",
        [scratch.tenantId],
      ),
    ).toEqual({ c: 0 });
    expect(
      await getOne("SELECT COUNT(*) as c FROM messages WHERE tenant_id = ?", [
        scratch.tenantId,
      ]),
    ).toEqual({ c: 0 });
  });

  it("cascades a tenant delete through its orders and customers", async () => {
    const scratch = await createTenantFixture("fk-cascade-orders");
    await fileOrder(scratch.ref("51900000003"));

    await run("DELETE FROM tenants WHERE id = ?", [scratch.tenantId]);

    for (const table of ["orders", "order_lines", "customers"]) {
      expect(
        await getOne(`SELECT COUNT(*) as c FROM ${table} WHERE tenant_id = ?`, [
          scratch.tenantId,
        ]),
      ).toEqual({ c: 0 });
    }
  });

  /** An order belongs to its customer, so it outlives the thread it came from. */
  it("keeps the order when its conversation is deleted", async () => {
    const ref = tenant.ref("51900000020");
    await insertConversation(ref);
    const order = await fileOrder(ref);

    await run(
      `DELETE FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
    );

    expect(
      await getOne("SELECT COUNT(*) as c FROM orders WHERE id = ?", [order.id]),
    ).toEqual({ c: 1 });
  });

  describe("routes that check before the constraint does", () => {
    function buildApp() {
      const app = new Hono();
      app.use("/api/*", requireAuth);
      app.route("/api/tenants", tenantRoutes);
      return app;
    }

    it("grants no membership to a user id that does not exist", async () => {
      const operatorId = await insertUser({
        name: "Operator",
        isPlatformOperator: true,
      });

      const token = generateSessionToken();
      await createSession(token, operatorId, null);

      const response = await buildApp().request(
        `/api/tenants/${tenant.tenantId}/members`,
        {
          method: "POST",
          headers: {
            Cookie: `session=${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId: "ghost-user", role: "admin" }),
        },
      );

      // A clean 404, not a constraint error and not an orphan row.
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "User not found" });
      expect(
        await getOne(
          "SELECT COUNT(*) as c FROM tenant_memberships WHERE user_id = 'ghost-user'",
        ),
      ).toEqual({ c: 0 });

      await run("DELETE FROM session WHERE user_id = ?", [operatorId]);
      await run("DELETE FROM users WHERE id = ?", [operatorId]);
    });

    it("creates the conversation before logging an inbound message", async () => {
      const contact = "51900000003";
      const account = await addChannelAccount(tenant);

      const response = await webhookRequest(
        "/",
        await signedWebhookRequest({
          entry: [
            {
              id: "waba-fk",
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: account.phoneNumberId },
                    messages: [
                      {
                        from: contact,
                        id: `wamid-${crypto.randomUUID()}`,
                        timestamp: String(Math.floor(Date.now() / 1000)),
                        type: "text",
                        text: { body: "hola" },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );

      expect(await response.json()).toEqual({
        results: [{ phoneNumberId: account.phoneNumberId, status: "received" }],
      });

      const ref = account.ref(contact);
      expect(
        await getOne(
          `SELECT COUNT(*) as c FROM conversations
             WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
          [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
        ),
      ).toEqual({ c: 1 });
      expect(await MessageStore.getHistory(ref)).toHaveLength(1);
    });
  });
});

/**
 * Every table carrying both columns has to reference the pair, not the two
 * columns separately. The tests above prove it one table at a time. This one
 * catches a new table with independent references, which would compile, pass
 * its own tests, and accept cross-tenant rows.
 */
describe("the composite reference itself", () => {
  type Row = Record<string, unknown>;

  async function rows<T = Row>(sql: string): Promise<T[]> {
    return (await env.DB.prepare(sql).all<T>()).results;
  }

  async function tables(): Promise<string[]> {
    return (
      await rows<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
    ).map((t) => t.name);
  }

  function foreignKeys<T>(table: string): Promise<T[]> {
    return rows<T>(`PRAGMA foreign_key_list(${table})`);
  }

  async function tablesWithBothColumns(): Promise<string[]> {
    const result: string[] = [];
    for (const name of await tables()) {
      const columns = await rows<{ name: string }>(
        `PRAGMA table_info(${name})`,
      );
      const has = (column: string) => columns.some((c) => c.name === column);
      if (has("tenant_id") && has("channel_account_id")) result.push(name);
    }
    return result;
  }

  /**
   * The simulator's delete route removes a conversation as a whole, so every
   * table that references one must cascade the delete. A new table hung off a
   * conversation fails the expected list, and a key with any other ON DELETE
   * action fails the cascade check.
   */
  it("cascades on every table that references a conversation", async () => {
    const referencing: string[] = [];
    for (const name of await tables()) {
      const keys = await foreignKeys<{ table: string }>(name);
      if (keys.some((key) => key.table === "conversations")) {
        referencing.push(name);
      }
    }

    expect(referencing.sort()).toEqual(["messages", "outbox", "unread_alerts"]);

    for (const table of referencing) {
      const keys = (
        await foreignKeys<{ table: string; on_delete: string }>(table)
      ).filter((key) => key.table === "conversations");

      // One row per column of the key, all carrying the same action.
      const actions = [...new Set(keys.map((key) => key.on_delete))];

      expect({ table, onDelete: actions }).toEqual({
        table,
        onDelete: ["CASCADE"],
      });
    }
  });

  it("is on every table that names a tenant and a channel account", async () => {
    const tables = await tablesWithBothColumns();

    // channel_accounts itself is the parent, so it is not in this set.
    expect(tables.sort()).toEqual([
      "analytics_events",
      "conversations",
      "llm_calls",
      "message_inbox",
      "messages",
      "orders",
      "outbox",
      "unread_alerts",
    ]);

    for (const table of tables) {
      const keys = await foreignKeys<{
        id: number;
        table: string;
        from: string;
        to: string | null;
      }>(table);

      // One foreign key (same `id`) covering both columns at once. Two keys
      // that each happen to point at channel_accounts would not do: it is the
      // pair being checked together that rules the mismatch out.
      const composite = keys.filter((key) => key.table === "channel_accounts");
      const ids = new Set(composite.map((key) => key.id));

      expect({ table, ids: ids.size }).toEqual({ table, ids: 1 });
      expect({
        table,
        columns: composite.map((key) => `${key.from}->${key.to}`).sort(),
      }).toEqual({
        table,
        columns: ["channel_account_id->id", "tenant_id->tenant_id"],
      });
    }
  });
});
