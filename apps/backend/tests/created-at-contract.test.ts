/**
 * Each `*_at` field in packages/types over an INTEGER column reaches the client
 * as a JSON number of milliseconds, or null when a nullable column is unset.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type {
  Conversation,
  ConversationMessage,
  HistoryEntry,
  OrderDetail,
  OrderSummary,
  Product,
  User,
} from "@vendeya/types";

import {
  createMember,
  createTenantFixture,
  fileOrder,
  insertConversation,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import conversationRoutes from "../src/routes/conversations.ts";
import catalogRoutes from "../src/routes/catalog.ts";
import orderRoutes from "../src/routes/orders.ts";
import adminUserRoutes from "../src/routes/admin/users.ts";
import historyRoutes from "../src/routes/history.ts";
import { ProductService } from "../src/domains/catalog/products.ts";
import { OrderWrites } from "../src/domains/orders/index.ts";
import { assignNextAgentHeld } from "../src/domains/conversations/assignment.ts";
import { logAction } from "../src/platform/audit/logger.ts";
import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";

const PHONE = "51987654321";

/** A seconds value is about 1.8e9, so this bound rejects it as well as text. */
const MILLISECONDS_SINCE_2001 = 1e12;

/** The `number` parameter binds the declared type. A field declared `string` fails to compile at the call. */
function expectMilliseconds(value: number): void {
  expect(typeof value).toBe("number");
  expect(value).toBeGreaterThan(MILLISECONDS_SINCE_2001);
}

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("/api/*", requireAuth);
  app.route("/api/conversations", conversationRoutes);
  app.route("/api/catalog", catalogRoutes);
  app.route("/api/orders", orderRoutes);
  app.route("/api/history", historyRoutes);
  app.use("/api/admin/*", requireRole("admin"));
  app.route("/api/admin/users", adminUserRoutes);
  return app;
}

describe("created_at over HTTP", () => {
  let app: ReturnType<typeof buildApp>;
  let tenant: TenantFixture;
  let cookie: string;
  let userId: string;

  beforeEach(async () => {
    app = buildApp();
    tenant = await createTenantFixture("created-at");

    const admin = await createMember(tenant);
    userId = admin.userId;
    const token = generateSessionToken();
    await createSession(token, userId, tenant.tenantId);
    cookie = `session=${token}`;

    await insertConversation(tenant.ref(PHONE));
  });

  async function getJson<T>(path: string): Promise<T> {
    const response = await app.request(path, {
      headers: { Cookie: cookie, "X-Tenant-Id": tenant.tenantId },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  }

  it("returns Product.created_at as a number", async () => {
    await ProductService.create({
      tenantId: tenant.tenantId,
      name: "Cocina",
      category: "cocinas",
    });

    const products = await getJson<Product[]>("/api/catalog/products");

    expect(products).toHaveLength(1);
    expectMilliseconds(products[0]!.created_at);
  });

  it("returns ConversationMessage.created_at as a number", async () => {
    await MessageStore.log(tenant.ref(PHONE), "inbound", "text", "hola");

    const detail = await getJson<{ messages: ConversationMessage[] }>(
      `/api/conversations/${PHONE}`,
    );

    expect(detail.messages).toHaveLength(1);
    expectMilliseconds(detail.messages[0]!.created_at);
  });

  it("returns Conversation.last_activity_at as a number and assignment_notified_at as null until it is set", async () => {
    const { conversation } = await getJson<{ conversation: Conversation }>(
      `/api/conversations/${PHONE}`,
    );

    expectMilliseconds(conversation.last_activity_at);
    expect(conversation.assignment_notified_at).toBeNull();
  });

  it("returns Conversation.assignment_notified_at as a number once set", async () => {
    await createMember(tenant, "sales_agent");
    await assignNextAgentHeld(tenant.ref(PHONE));

    const detail = await getJson<{ conversation: Conversation }>(
      `/api/conversations/${PHONE}`,
    );
    const [listed] = await getJson<Conversation[]>("/api/conversations");

    for (const conversation of [detail.conversation, listed!]) {
      expectMilliseconds(conversation.assignment_notified_at!);
    }
  });

  it("returns Order.created_at as a number", async () => {
    await fileOrder(tenant.ref(PHONE));

    const orders = await getJson<OrderSummary[]>("/api/orders");

    expect(orders).toHaveLength(1);
    expectMilliseconds(orders[0]!.created_at);
  });

  it("returns Order.updated_at as a number, before and after a status change", async () => {
    const created = await fileOrder(tenant.ref(PHONE));

    const [listed] = await getJson<OrderSummary[]>("/api/orders");
    expectMilliseconds(listed!.updated_at);

    await OrderWrites.transition(
      tenant.tenantId,
      created.id,
      "confirmed",
      userId,
    );

    const changed = await getJson<OrderDetail>(`/api/orders/${created.id}`);
    expectMilliseconds(changed.updated_at);
  });

  it("returns HistoryEntry.at as a number", async () => {
    await logAction(
      { userId, tenantId: tenant.tenantId },
      "test_action",
      "test",
    );

    const { entries } = await getJson<{ entries: HistoryEntry[] }>(
      "/api/history",
    );

    expect(entries).toHaveLength(1);
    expectMilliseconds(entries[0]!.at);
  });

  it("returns User.created_at as a number", async () => {
    const { users } = await getJson<{ users: Array<Pick<User, "created_at">> }>(
      "/api/admin/users",
    );

    expect(users).toHaveLength(1);
    expectMilliseconds(users[0]!.created_at);
  });
});
