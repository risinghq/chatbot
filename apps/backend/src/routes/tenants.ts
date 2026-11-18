import { Hono } from "hono";
import { pathParam } from "../lib/http.ts";
import {
  MembershipService,
  TenantService,
  isTenantRole,
} from "../domains/tenants/index.ts";
import { setSessionTenant } from "../platform/auth/session.ts";
import { auditStatement, logAction } from "../platform/audit/logger.ts";
import { requirePlatformOperator } from "../middleware/auth.ts";
import { hasOpenAiApiKey } from "../domains/settings/openai.ts";
import { batch, getOne } from "../db/index.ts";

const tenants = new Hono();

/** Tenants the caller can see, with the caller's role in each. */
tenants.get("/", async (c) => {
  const scope = c.get("scope");

  // `ai_configured` reports whether the tenant's own OpenAI key is stored,
  // so the dashboard can say the bot cannot think when it is missing.
  if (scope.isPlatformOperator) {
    const all = await TenantService.getAll();
    return c.json({
      tenants: await Promise.all(
        all.map(async (t) => ({
          ...t,
          role: null,
          ai_configured: await hasOpenAiApiKey(t.id),
        })),
      ),
      isPlatformOperator: true,
      activeTenantId: scope.tenantId,
    });
  }

  const memberships = await MembershipService.listForUser(scope.userId);
  return c.json({
    tenants: await Promise.all(
      memberships.map(async (t) => ({
        ...t,
        ai_configured: await hasOpenAiApiKey(t.id),
      })),
    ),
    isPlatformOperator: false,
    activeTenantId: scope.tenantId,
  });
});

/** Repoint the session at a tenant. */
tenants.post("/active", async (c) => {
  const scope = c.get("scope");
  const session = c.get("session");
  const { tenantId } = await c.req.json();

  // Passing null returns a platform operator to unscoped, cross-tenant reads.
  if (tenantId === null || tenantId === undefined) {
    if (!scope.isPlatformOperator) {
      return c.json(
        { error: "Only platform operators may act without a tenant" },
        403,
      );
    }
    await setSessionTenant(session.id, null);
    return c.json({ activeTenantId: null });
  }

  if (typeof tenantId !== "string") {
    return c.json({ error: "tenantId must be a string or null" }, 400);
  }

  const tenant = await TenantService.getById(tenantId);
  if (tenant?.status !== "active") {
    return c.json({ error: "Tenant not found" }, 404);
  }

  // Membership is checked here rather than trusted from the request. A
  // platform operator may select any open tenant.
  const role = await MembershipService.roleFor(tenantId, scope.userId);

  if (!role && !scope.isPlatformOperator) {
    // Do not distinguish "no such tenant" from "not yours".
    return c.json({ error: "Tenant not found" }, 404);
  }

  await setSessionTenant(session.id, tenantId);

  await logAction(
    { userId: scope.userId, tenantId },
    "select_tenant",
    "tenant",
    tenantId,
    { asPlatformOperator: scope.isPlatformOperator && !role },
  );

  return c.json({ activeTenantId: tenantId, role });
});

tenants.post("/", requirePlatformOperator, async (c) => {
  const scope = c.get("scope");
  const { slug, name } = await c.req.json();

  const problem = await TenantService.newTenantProblem(slug, name);
  if (problem) {
    return c.json({ error: problem.message }, problem.taken ? 409 : 400);
  }

  const id = crypto.randomUUID();
  await batch([
    TenantService.createStatement({ id, slug, name }),
    auditStatement(
      { userId: scope.userId, tenantId: id },
      "create_tenant",
      "tenant",
      id,
      { slug, name },
    ),
  ]);

  return c.json(await TenantService.getById(id), 201);
});

tenants.post("/:id/members", requirePlatformOperator, async (c) => {
  const scope = c.get("scope");
  const tenantId = pathParam(c, "id");
  const { userId, role } = await c.req.json();

  if (!userId || !isTenantRole(role)) {
    return c.json({ error: "userId and a valid role are required" }, 400);
  }

  if (!(await TenantService.getById(tenantId))) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  if (
    !(await getOne<{ id: string }>("SELECT id FROM users WHERE id = ?", [
      userId,
    ]))
  ) {
    return c.json({ error: "User not found" }, 404);
  }

  const membership = await MembershipService.upsert({
    tenantId,
    userId,
    role,
    createdBy: scope.userId,
  });

  await logAction(
    { userId: scope.userId, tenantId },
    "grant_membership",
    "user",
    userId,
    { role },
  );

  return c.json(membership, 201);
});

export default tenants;
