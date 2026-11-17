import { tenantPredicate } from "../../db/query.ts";
import type { Binding } from "../../db/index.ts";
import type { ConversationRef, Order, OrderMetrics } from "@vendeya/types";
import type { OrderFilters } from "./types.ts";
import { getAll, getOne } from "../../db/index.ts";

/**
 * A sales agent's orders: the ones they created, and the ones from a
 * conversation assigned to them. `orders.assigned_agent` names whoever created
 * the order through the API and is null for an order the bot files. An order
 * reaches its conversation by (tenant, channel account, phone), the composite
 * foreign key on `orders`. Both placeholders take the agent's id.
 */
const AGENT_ORDERS = `(orders.assigned_agent = ? OR EXISTS (
  SELECT 1 FROM conversations c
  WHERE c.tenant_id = orders.tenant_id
    AND c.channel_account_id = orders.channel_account_id
    AND c.phone_number = orders.conversation_phone
    AND c.assigned_agent = ?))`;

/**
 * A null `tenantId` reads across open tenants. Route handlers pass the caller's
 * scope, so only an unpinned platform operator reaches that case.
 */
export async function getOrders(
  tenantId: string | null,
  filters: OrderFilters = {},
): Promise<Order[]> {
  let query = "SELECT * FROM orders WHERE 1=1";
  const params: Binding[] = [];

  query += ` AND ${tenantPredicate(tenantId)}`;
  if (tenantId) params.push(tenantId);

  if (filters.status) {
    query += " AND status = ?";
    params.push(filters.status);
  }

  if (filters.startMs !== undefined) {
    query += " AND created_at >= ?";
    params.push(filters.startMs);
  }

  if (filters.endMs !== undefined) {
    query += " AND created_at <= ?";
    params.push(filters.endMs);
  }

  if (filters.assignedAgent) {
    query += " AND assigned_agent = ?";
    params.push(filters.assignedAgent);
  }

  if (filters.conversationAgent) {
    query += ` AND ${AGENT_ORDERS}`;
    params.push(filters.conversationAgent, filters.conversationAgent);
  }

  query += " ORDER BY created_at DESC";

  const limit = filters.limit || 50;
  const offset = filters.offset || 0;
  query += " LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const rows = await getAll<Order>(query, params);
  return rows;
}

/** `conversationAgent` narrows to that sales agent's orders. */
export async function getOrderById(
  tenantId: string | null,
  id: string,
  conversationAgent: string | null = null,
): Promise<Order | null> {
  let query = `SELECT * FROM orders WHERE id = ? AND ${tenantPredicate(tenantId)}`;
  const params: Binding[] = tenantId ? [id, tenantId] : [id];

  if (conversationAgent) {
    query += ` AND ${AGENT_ORDERS}`;
    params.push(conversationAgent, conversationAgent);
  }

  return (await getOne<Order>(query, params)) ?? null;
}

/** `conversationAgent` narrows to that sales agent's orders. */
export async function getOrderByConversation(
  ref: ConversationRef,
  conversationAgent: string | null = null,
): Promise<Order | null> {
  const params: Binding[] = [
    ref.tenantId,
    ref.channelAccountId,
    ref.phoneNumber,
  ];
  let agentClause = "";
  if (conversationAgent) {
    agentClause = ` AND ${AGENT_ORDERS}`;
    params.push(conversationAgent, conversationAgent);
  }

  return (
    (await getOne<Order>(
      `SELECT * FROM orders
       WHERE tenant_id = ? AND channel_account_id = ? AND conversation_phone = ?${agentClause}
       ORDER BY created_at DESC LIMIT 1`,
      params,
    )) ?? null
  );
}

/** `conversationAgent` narrows to that sales agent's orders. */
export async function getOrderMetrics(
  tenantId: string | null,
  conversationAgent: string | null = null,
): Promise<OrderMetrics> {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  let scope = tenantPredicate(tenantId);
  const scopeParams: Binding[] = tenantId ? [tenantId] : [];

  if (conversationAgent) {
    scope += ` AND ${AGENT_ORDERS}`;
    scopeParams.push(conversationAgent, conversationAgent);
  }

  const count = async (
    extra: string,
    params: Binding[] = [],
  ): Promise<number> =>
    (await getOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM orders WHERE ${scope}${extra}`,
      [...scopeParams, ...params],
    ))!.count;

  const revenue = async (
    extra: string,
    params: Binding[] = [],
  ): Promise<number> =>
    (await getOne<{ revenue: number }>(
      `SELECT COALESCE(SUM(total_amount), 0) as revenue FROM orders WHERE ${scope}${extra}`,
      [...scopeParams, ...params],
    ))!.revenue;

  const totalOrders = await count("");
  const pendingCount = await count(" AND status = 'pending'");
  const supervisorApprovedCount = await count(
    " AND status = 'supervisor_approved'",
  );
  const calidaApprovedCount = await count(" AND status = 'calidda_approved'");
  const deliveredCount = await count(" AND status = 'delivered'");
  const rejectedCount = await count(" AND status LIKE '%rejected%'");

  const totalRevenue = await revenue(" AND status = 'delivered'");
  const revenueThisMonth = await revenue(
    " AND status = 'delivered' AND created_at >= ?",
    [thirtyDaysAgo],
  );

  const avgOrderValue = deliveredCount > 0 ? totalRevenue / deliveredCount : 0;

  const approvalRate =
    totalOrders > 0
      ? ((deliveredCount + calidaApprovedCount) / totalOrders) * 100
      : 0;

  const rejectionRate =
    totalOrders > 0 ? (rejectedCount / totalOrders) * 100 : 0;

  return {
    totalOrders,
    pendingCount,
    supervisorApprovedCount,
    calidaApprovedCount,
    deliveredCount,
    rejectedCount,
    totalRevenue,
    revenueThisMonth,
    avgOrderValue,
    approvalRate,
    rejectionRate,
  };
}
