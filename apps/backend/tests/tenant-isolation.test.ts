import { describe, it, expect, beforeEach } from "vitest";
import { getAll, getOne, run } from "../src/db/index.ts";
import type { ConversationRef } from "@vendeya/types";

import {
  createMember,
  createTenantFixture,
  fileOrder,
  insertConversation,
  type TenantFixture,
  setChannelStatus,
} from "./helpers/tenancy.ts";

import { webhookRequest } from "./helpers/turn.ts";
import { signedWebhookRequest } from "./helpers/webhook.ts";
import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";
import { BundleService } from "../src/domains/catalog/bundles.ts";
import { PeriodService } from "../src/domains/catalog/periods.ts";
import { ProductService } from "../src/domains/catalog/products.ts";
import { AssetService } from "../src/domains/assets/index.ts";
import { canAccessTenant } from "../src/platform/auth/scope.ts";
import { OrderReads } from "../src/domains/orders/index.ts";
import {
  listConversations,
  lookupConversation,
} from "../src/domains/conversations/read.ts";
import {
  findConversation,
  getOrCreateConversation,
} from "../src/conversation/store.ts";
import {
  trackEventStatement,
  getRecentEvents,
} from "../src/domains/analytics/index.ts";
import {
  getRecentLLMCalls,
  trackLLMCall,
} from "../src/intelligence/tracker.ts";
import { assignNextAgentHeld } from "../src/domains/conversations/assignment.ts";
import { MembershipService } from "../src/domains/tenants/index.ts";
import { PersonasService } from "../src/domains/personas/index.ts";
import { seedPeriods } from "../src/db/seeds/periods.ts";
import { seedProducts } from "../src/db/seeds/products.ts";
import { seedBundles } from "../src/db/seeds/bundles.ts";

/**
 * The same customer phone number, messaging two different businesses. The
 * conversation tests are about that collision. The later blocks cover the other
 * places two tenants could collide, from catalog ids to webhook routing.
 */
const SHARED_PHONE = "51987654321";

describe("tenant isolation", () => {
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaRef: ConversationRef;
  let betaRef: ConversationRef;

  beforeEach(async () => {
    alpha = await createTenantFixture("alpha");
    beta = await createTenantFixture("beta");
    alphaRef = alpha.ref(SHARED_PHONE);
    betaRef = beta.ref(SHARED_PHONE);
  });

  describe("the same phone number in two tenants", () => {
    it("creates two independent conversations", async () => {
      const a = await getOrCreateConversation(alphaRef);
      const b = await getOrCreateConversation(betaRef);

      expect(a.ref.tenantId).toBe(alpha.tenantId);
      expect(b.ref.tenantId).toBe(beta.tenantId);

      const rows = (await getAll(
        "SELECT tenant_id FROM conversations WHERE phone_number = ? AND tenant_id IN (?, ?)",
        [SHARED_PHONE, alpha.tenantId, beta.tenantId],
      )) as Array<{
        tenant_id: string;
      }>;

      expect(rows).toHaveLength(2);
    });

    it("keeps conversation state separate", async () => {
      await insertConversation(alphaRef, { clientName: "Alpha Client" });
      await insertConversation(betaRef, { clientName: "Beta Client" });

      expect((await findConversation(alphaRef))?.client_name).toBe(
        "Alpha Client",
      );
      expect((await findConversation(betaRef))?.client_name).toBe(
        "Beta Client",
      );
    });

    it("keeps message history separate", async () => {
      await insertConversation(alphaRef);
      await insertConversation(betaRef);

      await MessageStore.log(alphaRef, "inbound", "text", "hola alpha");
      await MessageStore.log(betaRef, "inbound", "text", "hola beta");

      const alphaMessages = await MessageStore.getHistory(alphaRef);
      const betaMessages = await MessageStore.getHistory(betaRef);

      expect(alphaMessages).toHaveLength(1);
      expect(alphaMessages[0]!.content).toBe("hola alpha");
      expect(betaMessages).toHaveLength(1);
      expect(betaMessages[0]!.content).toBe("hola beta");
    });

    it("keeps analytics events separate", async () => {
      await insertConversation(alphaRef);
      await insertConversation(betaRef);

      await trackEventStatement(alphaRef, "session_start").run();
      await trackEventStatement(betaRef, "session_start").run();

      const alphaEvents = await getRecentEvents(alpha.tenantId, 50);
      const betaEvents = await getRecentEvents(beta.tenantId, 50);

      expect(alphaEvents).toHaveLength(1);
      expect(betaEvents).toHaveLength(1);
      expect(alphaEvents[0]!.tenant_id).toBe(alpha.tenantId);
      expect(betaEvents[0]!.tenant_id).toBe(beta.tenantId);
    });
  });

  describe("reads outside the caller's tenant", () => {
    it("does not list another tenant's conversations", async () => {
      await insertConversation(alphaRef, { clientName: "Alpha Client" });
      await insertConversation(betaRef, { clientName: "Beta Client" });

      const alphaAdmin = await createMember(alpha, "admin");
      const rows = await listConversations(alphaAdmin.scope, null);

      expect(rows.every((r) => r.tenant_id === alpha.tenantId)).toBe(true);
      expect(rows.map((r) => r.client_name)).not.toContain("Beta Client");
    });

    it("does not resolve another tenant's conversation by phone number", async () => {
      await insertConversation(betaRef, { clientName: "Beta Client" });

      const alphaAdmin = await createMember(alpha, "admin");
      const resolved = await lookupConversation(
        alphaAdmin.scope,
        SHARED_PHONE,
        null,
      );

      expect(resolved.status).toBe("not_found");
    });

    it("scopes a sales agent to their own assignments inside their tenant", async () => {
      const alphaAgent = await createMember(alpha, "sales_agent");
      const betaAgent = await createMember(beta, "sales_agent");

      await insertConversation(alphaRef, {
        clientName: "Alpha Client",
        assignedAgent: alphaAgent.userId,
      });
      await insertConversation(betaRef, {
        clientName: "Beta Client",
        assignedAgent: betaAgent.userId,
      });

      const rows = await listConversations(alphaAgent.scope, null);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenant_id).toBe(alpha.tenantId);
    });

    it("does not return another tenant's orders", async () => {
      await insertConversation(alphaRef);
      await insertConversation(betaRef);

      const alphaOrder = await fileOrder(alphaRef, { name: "Alpha Client" });
      const betaOrder = await fileOrder(betaRef, { name: "Beta Client" });

      expect(
        (await OrderReads.list(alpha.tenantId, {})).map((o) => o.id),
      ).toEqual([alphaOrder.id]);
      expect(await OrderReads.detail(alpha.tenantId, betaOrder.id)).toBeNull();
      expect((await OrderReads.latestForConversation(alphaRef))?.id).toBe(
        alphaOrder.id,
      );
      expect((await OrderReads.latestForConversation(betaRef))?.id).toBe(
        betaOrder.id,
      );
    });

    it("does not return another tenant's catalog", async () => {
      const alphaPeriod = await PeriodService.create({
        tenantId: alpha.tenantId,
        name: "Septiembre",
        year_month: "2026-09",
        created_by: null,
      });
      // The same period name in another tenant must not collide.
      const betaPeriod = await PeriodService.create({
        tenantId: beta.tenantId,
        name: "Septiembre",
        year_month: "2026-09",
        created_by: null,
      });

      expect(alphaPeriod.id).not.toBe(betaPeriod.id);
      expect(
        await PeriodService.getById(alpha.tenantId, betaPeriod.id),
      ).toBeNull();
      expect(await PeriodService.getAll(alpha.tenantId)).toHaveLength(1);

      await PeriodService.updateStatus(
        alpha.tenantId,
        alphaPeriod.id,
        "active",
      );
      await PeriodService.updateStatus(beta.tenantId, betaPeriod.id, "active");

      // Publishing one tenant's period must not archive another's.
      expect((await PeriodService.getActive(alpha.tenantId))?.id).toBe(
        alphaPeriod.id,
      );
      expect((await PeriodService.getActive(beta.tenantId))?.id).toBe(
        betaPeriod.id,
      );

      const betaBundle = await BundleService.create({
        id: `bundle-${crypto.randomUUID()}`,
        tenantId: beta.tenantId,
        period_id: betaPeriod.id,
        segment: "gaso",
        name: "Beta Combo",
        price: 500,
        primary_category: "cocinas",
        categories_json: "[]",
        image_id: "beta-image",
        composition_json: '{"fixed":[],"choices":[]}',
        installments_json: "[]",
        created_by: null,
      });

      expect(
        await BundleService.getById(alpha.tenantId, betaBundle.id),
      ).toBeNull();
      expect(await BundleService.getAvailable(alpha.tenantId)).toHaveLength(0);
      expect(await BundleService.getAvailable(beta.tenantId)).toHaveLength(1);
      expect(
        await BundleService.getByPeriod(alpha.tenantId, betaPeriod.id),
      ).toHaveLength(0);

      await ProductService.create({
        tenantId: beta.tenantId,
        name: "Beta Product",
        category: "cocinas",
      });

      expect(await ProductService.getAll(alpha.tenantId)).toHaveLength(0);
      expect(await ProductService.getAll(beta.tenantId)).toHaveLength(1);
    });

    it("does not return another tenant's media assets", async () => {
      const betaAsset = await AssetService.create({
        tenantId: beta.tenantId,
        kind: "contract",
        visibility: "private",
        storageKey: `${beta.tenantId}/contracts/x.pdf`,
      });

      const alphaAdmin = await createMember(alpha, "admin");

      expect(
        await AssetService.getById(alpha.tenantId, betaAsset.id),
      ).toBeNull();
      expect(await AssetService.listForTenant(alpha.tenantId)).toHaveLength(0);

      // This is the check /api/assets/:id makes before serving any bytes.
      expect(await canAccessTenant(alphaAdmin.scope, betaAsset.tenant_id)).toBe(
        false,
      );
      expect(await canAccessTenant(alphaAdmin.scope, alpha.tenantId)).toBe(
        true,
      );
    });

    it("does not return another tenant's LLM traces", async () => {
      await insertConversation(alphaRef);
      await insertConversation(betaRef);

      for (const ref of [alphaRef, betaRef]) {
        trackLLMCall({
          ref,
          operation: "isQuestion",
          model: "test-model",
          prompt: "",
          userMessage: "",
          status: "success",
          latencyMs: 1,
        });
      }

      // trackLLMCall writes on a detached promise. Drain the microtask queue.
      return Promise.resolve().then(async () => {
        const alphaCalls = (await getRecentLLMCalls(
          alpha.tenantId,
          50,
        )) as Array<{
          tenant_id: string;
        }>;
        const betaCalls = (await getRecentLLMCalls(
          beta.tenantId,
          50,
        )) as Array<{
          tenant_id: string;
        }>;

        expect(alphaCalls).toHaveLength(1);
        expect(betaCalls).toHaveLength(1);
        expect(alphaCalls[0]!.tenant_id).toBe(alpha.tenantId);
        expect(betaCalls[0]!.tenant_id).toBe(beta.tenantId);
      });
    });
  });

  describe("platform operators", () => {
    it("read across tenants only while unpinned, and are scoped once pinned", async () => {
      await insertConversation(alphaRef, { clientName: "Alpha Client" });
      await insertConversation(betaRef, { clientName: "Beta Client" });

      const unpinned = {
        userId: "op-1",
        tenantId: null,
        membershipRole: null,
        isPlatformOperator: true,
      };

      const acrossTenants = (await listConversations(unpinned, null))
        .filter((r) => [alpha.tenantId, beta.tenantId].includes(r.tenant_id))
        .map((r) => r.tenant_id);

      expect(acrossTenants.sort()).toEqual(
        [alpha.tenantId, beta.tenantId].sort(),
      );

      const pinned = { ...unpinned, tenantId: alpha.tenantId };
      const scoped = await listConversations(pinned, null);

      expect(scoped.every((r) => r.tenant_id === alpha.tenantId)).toBe(true);
    });

    it("refuses a user who is neither a member nor platform staff", async () => {
      await insertConversation(alphaRef, { clientName: "Alpha Client" });

      const outsider = {
        userId: "u-outsider",
        tenantId: null,
        membershipRole: null,
        isPlatformOperator: false,
      };

      expect(
        (await lookupConversation(outsider, SHARED_PHONE, null)).status,
      ).toBe("not_found");
    });
  });

  /**
   * Availability lives on the membership, not on the user record. An agent who
   * goes offline for one business stays in the other's rotation.
   */
  describe("an agent who sells for both", () => {
    let agentId: string;

    beforeEach(async () => {
      const agent = await createMember(alpha, "sales_agent");
      agentId = agent.userId;

      await run(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
         VALUES (?, ?, ?, 'sales_agent')`,
        [crypto.randomUUID(), beta.tenantId, agentId],
      );

      await insertConversation(alphaRef);
      await insertConversation(betaRef);
    });

    it("stays in the other tenant's rotation after going offline in one", async () => {
      await MembershipService.setAvailability(alpha.tenantId, agentId, false);

      expect(await assignNextAgentHeld(alphaRef)).toBeNull();
      expect(await assignNextAgentHeld(betaRef)).toBe(agentId);
    });

    it("is assigned in both while available in both", async () => {
      expect(await assignNextAgentHeld(alphaRef)).toBe(agentId);
      expect(await assignNextAgentHeld(betaRef)).toBe(agentId);
    });

    it("is out of both when the account itself is deactivated", async () => {
      await run("UPDATE users SET is_active = 0 WHERE id = ?", [agentId]);

      expect(await assignNextAgentHeld(alphaRef)).toBeNull();
      expect(await assignNextAgentHeld(betaRef)).toBeNull();
    });
  });

  /**
   * `products.id` is a global primary key, so the catalog seeds must give each
   * tenant ids of its own.
   */
  describe("seeding a second business", () => {
    async function seedCatalog(tenantId: string) {
      await seedPeriods(tenantId);
      await seedProducts(tenantId);
      await seedBundles(tenantId);
    }

    it("gives each tenant its own copy of the base catalog", async () => {
      await seedCatalog(alpha.tenantId);
      await seedCatalog(beta.tenantId);

      const alphaProducts = await ProductService.getAll(alpha.tenantId);
      const betaProducts = await ProductService.getAll(beta.tenantId);

      expect(alphaProducts.length).toBeGreaterThan(0);
      expect(betaProducts).toHaveLength(alphaProducts.length);

      const alphaIds = new Set(alphaProducts.map((p) => p.id));
      expect(betaProducts.some((p) => alphaIds.has(p.id))).toBe(false);

      const alphaBundles = await BundleService.getAvailable(alpha.tenantId);
      expect(alphaBundles.length).toBeGreaterThan(0);
      expect(await BundleService.getAvailable(beta.tenantId)).toHaveLength(
        alphaBundles.length,
      );
    });

    it("keeps each bundle's composition pointing at its own tenant's products", async () => {
      await seedCatalog(alpha.tenantId);
      await seedCatalog(beta.tenantId);

      // getActiveBrands joins composition_json back to `products` inside the
      // tenant, so brands only come out if the snapshotted ids are that
      // tenant's own.
      const brands = await ProductService.getActiveBrands(beta.tenantId);
      expect(brands.length).toBeGreaterThan(0);
      expect(await ProductService.getActiveBrands(alpha.tenantId)).toEqual(
        brands,
      );
    });
  });

  /**
   * A persona id is typed in by a tenant's own users, so it is unique only
   * within its tenant.
   */
  describe("simulator personas", () => {
    const PERSONA_ID = "cliente_moroso";

    function persona(clientName: string) {
      return {
        id: PERSONA_ID,
        name: "Cliente moroso",
        description: "Deuda vigente",
        segment: "gaso" as const,
        clientName,
        dni: "12345678",
        creditLine: 3000,
      };
    }

    it("lets two tenants use the same persona id", async () => {
      const alphaAuthor = (await createMember(alpha)).userId;
      const betaAuthor = (await createMember(beta)).userId;

      await PersonasService.create(alpha.tenantId, persona("Ana"), alphaAuthor);
      await PersonasService.create(beta.tenantId, persona("Beto"), betaAuthor);

      expect(
        (await PersonasService.getById(alpha.tenantId, PERSONA_ID))?.clientName,
      ).toBe("Ana");
      expect(
        (await PersonasService.getById(beta.tenantId, PERSONA_ID))?.clientName,
      ).toBe("Beto");
    });

    it("keeps an edit inside the tenant that made it", async () => {
      const alphaAuthor = (await createMember(alpha)).userId;
      const betaAuthor = (await createMember(beta)).userId;

      await PersonasService.create(alpha.tenantId, persona("Ana"), alphaAuthor);
      await PersonasService.create(beta.tenantId, persona("Beto"), betaAuthor);

      await PersonasService.update(alpha.tenantId, PERSONA_ID, {
        clientName: "Ana María",
      });

      expect(
        (await PersonasService.getById(alpha.tenantId, PERSONA_ID))?.clientName,
      ).toBe("Ana María");
      expect(
        (await PersonasService.getById(beta.tenantId, PERSONA_ID))?.clientName,
      ).toBe("Beto");
    });

    it("keeps a deletion inside the tenant that made it", async () => {
      const alphaAuthor = (await createMember(alpha)).userId;
      const betaAuthor = (await createMember(beta)).userId;

      await PersonasService.create(alpha.tenantId, persona("Ana"), alphaAuthor);
      await PersonasService.create(beta.tenantId, persona("Beto"), betaAuthor);

      await PersonasService.delete(alpha.tenantId, PERSONA_ID);

      expect(
        (await PersonasService.getById(beta.tenantId, PERSONA_ID))?.clientName,
      ).toBe("Beto");
    });
  });

  describe("inbound webhook routing", () => {
    function payload(phoneNumberId: string, from: string, body: string) {
      return {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba-1",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: {
                    display_phone_number: "51900000000",
                    phone_number_id: phoneNumberId,
                  },
                  messages: [
                    {
                      from,
                      id: `wamid-${crypto.randomUUID()}`,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: "text",
                      text: { body },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
    }

    /**
     * One entry per number, each carrying however many messages Meta batched
     * into it. A single POST legitimately spans WABAs, numbers and tenants.
     */
    function batch(
      changes: Array<{ phoneNumberId: string; bodies: string[] }>,
    ) {
      return {
        object: "whatsapp_business_account",
        entry: changes.map(({ phoneNumberId, bodies }, index) => ({
          id: `waba-${index}`,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "51900000000",
                  phone_number_id: phoneNumberId,
                },
                messages: bodies.map((body) => ({
                  from: SHARED_PHONE,
                  id: `wamid-${crypto.randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body },
                })),
              },
            },
          ],
        })),
      };
    }

    async function post(body: unknown) {
      return webhookRequest("/", await signedWebhookRequest(body));
    }

    /** What became of each message in the payload, in the order it was sent. */
    async function statuses(response: Response): Promise<string[]> {
      const body = (await response.json()) as {
        results: Array<{ status: string }>;
      };
      return body.results.map((result) => result.status);
    }

    async function queued(): Promise<
      Array<{ tenant_id: string; message_text: string }>
    > {
      return (await getAll(
        `SELECT tenant_id, message_text FROM message_inbox
           WHERE phone_number = ? ORDER BY id`,
        [SHARED_PHONE],
      )) as Array<{
        tenant_id: string;
        message_text: string;
      }>;
    }

    it("routes a message to the tenant that owns the receiving number", async () => {
      const response = await post(
        payload(beta.phoneNumberId, SHARED_PHONE, "hola beta"),
      );

      expect(await statuses(response)).toEqual(["received"]);

      const queued = (await getAll(
        "SELECT tenant_id, channel_account_id, message_text FROM message_inbox WHERE phone_number = ?",
        [SHARED_PHONE],
      )) as Array<{
        tenant_id: string;
        channel_account_id: string;
        message_text: string;
      }>;

      expect(queued).toHaveLength(1);
      expect(queued[0]!.tenant_id).toBe(beta.tenantId);
      expect(queued[0]!.channel_account_id).toBe(beta.channelAccountId);
      expect(queued[0]!.message_text).toBe("hola beta");
    });

    it("routes the same contact to different tenants by phone-number id", async () => {
      await post(payload(alpha.phoneNumberId, SHARED_PHONE, "hola alpha"));
      await post(payload(beta.phoneNumberId, SHARED_PHONE, "hola beta"));

      const byTenant = (await getAll(
        "SELECT tenant_id, message_text FROM message_inbox WHERE phone_number = ? ORDER BY id",
        [SHARED_PHONE],
      )) as Array<{
        tenant_id: string;
        message_text: string;
      }>;

      expect(byTenant).toHaveLength(2);
      expect(byTenant[0]).toEqual({
        tenant_id: alpha.tenantId,
        message_text: "hola alpha",
      });
      expect(byTenant[1]).toEqual({
        tenant_id: beta.tenantId,
        message_text: "hola beta",
      });

      // The inbound log is likewise split by tenant, not merged by phone number.
      expect(await MessageStore.getHistory(alphaRef)).toHaveLength(1);
      expect(await MessageStore.getHistory(betaRef)).toHaveLength(1);
    });

    it("refuses a delivery for an unknown phone-number id", async () => {
      const response = await post(
        payload("pnid-not-registered", SHARED_PHONE, "hola"),
      );

      // The signature cannot be checked without the channel's app secret, so
      // the whole body is refused before anything is read.
      expect(response.status).toBe(401);
      expect(
        await getOne(
          "SELECT COUNT(*) as count FROM message_inbox WHERE phone_number = ?",
          [SHARED_PHONE],
        ),
      ).toEqual({ count: 0 });
    });

    it("drops a message for a disabled channel account", async () => {
      await setChannelStatus(beta.channelAccountId, "disabled");

      const response = await post(
        payload(beta.phoneNumberId, SHARED_PHONE, "hola"),
      );

      expect(await statuses(response)).toEqual(["channel_account_disabled"]);
    });

    /**
     * Only `active` accepts messages, because the send side refuses every other
     * status. A number that accepted them anyway would leave the customer with
     * silence from a bot that believed it had answered.
     */
    it("drops a message for a pending channel account", async () => {
      await setChannelStatus(beta.channelAccountId, "pending");

      const response = await post(
        payload(beta.phoneNumberId, SHARED_PHONE, "hola"),
      );

      expect(await statuses(response)).toEqual(["channel_account_pending"]);

      // Nothing was queued for handling and no conversation was started, so
      // there is no state claiming a reply is on its way.
      expect(await queued()).toHaveLength(0);
      expect(
        await getOne(
          `SELECT COUNT(*) as count FROM conversations
             WHERE channel_account_id = ? AND phone_number = ?`,
          [beta.channelAccountId, SHARED_PHONE],
        ),
      ).toEqual({ count: 0 });
    });

    it("refuses a payload with no phone-number id", async () => {
      const body = payload(beta.phoneNumberId, SHARED_PHONE, "hola") as any;
      delete body.entry[0].changes[0].value.metadata;

      const response = await post(body);

      // A body naming no number has no app secret to check the signature
      // against, so it is refused like a bad signature.
      expect(response.status).toBe(401);
      expect(await queued()).toEqual([]);
    });

    /**
     * Reading only the first message would drop the rest while still answering
     * 200. One endpoint serves every tenant's numbers, so a batch spanning two
     * businesses is ordinary traffic.
     */
    it("delivers every message of a batch spanning two tenants", async () => {
      const response = await post(
        batch([
          {
            phoneNumberId: alpha.phoneNumberId,
            bodies: ["alpha uno", "alpha dos"],
          },
          { phoneNumberId: beta.phoneNumberId, bodies: ["beta uno"] },
        ]),
      );

      expect(await statuses(response)).toEqual([
        "received",
        "received",
        "received",
      ]);

      expect(await queued()).toEqual([
        { tenant_id: alpha.tenantId, message_text: "alpha uno" },
        { tenant_id: alpha.tenantId, message_text: "alpha dos" },
        { tenant_id: beta.tenantId, message_text: "beta uno" },
      ]);
    });

    it("refuses the whole batch when one number is unknown", async () => {
      const response = await post(
        batch([
          { phoneNumberId: "pnid-not-registered", bodies: ["huérfano"] },
          { phoneNumberId: beta.phoneNumberId, bodies: ["beta uno"] },
        ]),
      );

      // A body the signature cannot be checked against is refused whole:
      // nothing is delivered, not even the messages a known number carried.
      expect(response.status).toBe(401);
      expect(await queued()).toEqual([]);
    });

    it("ignores a message it has already queued", async () => {
      // Meta redelivers a whole batch after a 5xx, so the same message id can
      // arrive twice. The second time there is nothing left to do.
      const body = payload(beta.phoneNumberId, SHARED_PHONE, "hola");

      expect(await statuses(await post(body))).toEqual(["received"]);
      expect(await statuses(await post(body))).toEqual(["duplicate"]);

      expect(await queued()).toHaveLength(1);
      expect(await MessageStore.getHistory(betaRef)).toHaveLength(1);
    });

    it("stops delivering to a suspended tenant", async () => {
      await run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [
        beta.tenantId,
      ]);

      const response = await post(
        payload(beta.phoneNumberId, SHARED_PHONE, "hola"),
      );

      expect(await statuses(response)).toEqual(["tenant_not_active"]);
      expect(await queued()).toEqual([]);
    });
  });
});
