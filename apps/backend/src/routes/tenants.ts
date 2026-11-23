import { newId } from "@vendeya/utils";
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
import { normalizeEmail } from "../domains/accounts/index.ts";
import { batch, withoutTenantScope } from "../db/index.ts";

const tenants = new Hono();

/** An account is global: a user row is keyed by its id or email. */
const accounts = () =>
  withoutTenantScope("a user account is keyed by its id or email");

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
  const checked = TenantService.checkName((await c.req.json()).name);
  if ("problem" in checked) return c.json({ error: checked.problem }, 400);

  const id = newId();
  await batch([
    TenantService.createStatement({ id, name: checked.name }),
    auditStatement(
      { userId: scope.userId, tenantId: id },
      "create_tenant",
      "tenant",
      id,
      { name: checked.name },
    ),
  ]);

  return c.json(await TenantService.getById(id), 201);
});

tenants.post("/:id/members", requirePlatformOperator, async (c) => {
  const scope = c.get("scope");
  const tenantId = pathParam(c, "id");
  const { userId, email, role } = await c.req.json();
  const address = normalizeEmail(email);

  if ((!userId && !address) || !isTenantRole(role)) {
    return c.json(
      { error: "userId or email, and a valid role, are required" },
      400,
    );
  }

  if (!(await TenantService.getById(tenantId))) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  // The dashboard names a person by the email they log in with; account
  // tooling names the id. Either resolves to the same global user.
  const user = userId
    ? await accounts()
        .selectFrom("users")
        .select("id")
        .where("id", "=", userId)
        .executeTakeFirst()
    : address
      ? await accounts()
          .selectFrom("users")
          .select("id")
          .where("email", "=", address)
          .executeTakeFirst()
      : undefined;

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  const memberId = user.id;

  const membership = await MembershipService.upsert({
    tenantId,
    userId: memberId,
    role,
    createdBy: scope.userId,
  });

  await logAction(
    { userId: scope.userId, tenantId },
    "grant_membership",
    "user",
    memberId,
    { role },
  );

  return c.json(membership, 201);
});

export default tenants;
