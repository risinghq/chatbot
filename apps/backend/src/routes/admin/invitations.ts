import { Hono } from "hono";
import { publicOrigin } from "../../config.ts";
import { InvitationService } from "../../domains/invitations/index.ts";
import { pathParam } from "../../lib/http.ts";
import { activeTenantId, requireTenantScope } from "../../middleware/auth.ts";

/**
 * An admin brings people into the active tenant by invitation. The link is
 * shown once, for the admin to send however they reach the person.
 */
const invitations = new Hono();

invitations.use("/*", requireTenantScope);

invitations.get("/", async (c) =>
  c.json({
    invitations: await InvitationService.listPending(activeTenantId(c)),
  }),
);

invitations.post("/", async (c) => {
  const { email, role } = await c.req.json();
  const result = await InvitationService.create(
    activeTenantId(c),
    { email, role },
    c.get("user").id,
  );
  if (!result.ok) {
    return c.json(
      { error: result.error.message, reason: result.error.reason },
      result.error.reason === "already_member" ? 409 : 400,
    );
  }

  return c.json(
    {
      id: result.value.id,
      link: `${publicOrigin()}/invitacion/${result.value.token}`,
    },
    201,
  );
});

invitations.delete("/:id", async (c) =>
  (await InvitationService.revoke(
    activeTenantId(c),
    pathParam(c, "id"),
    c.get("user").id,
  ))
    ? c.json({ success: true })
    : c.json({ error: "Invitation not found" }, 404),
);

export default invitations;
