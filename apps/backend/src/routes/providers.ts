import { Hono } from "hono";
import { pathParam } from "../lib/http.ts";
import { requirePlatformOperator } from "../middleware/auth.ts";
import { getAllStatus } from "../adapters/providers/health.ts";
import { eligibilityHandler } from "../bootstrap/index.ts";
import { TenantService } from "../domains/tenants/index.ts";
import { isOk } from "../shared/result/index.ts";
import type { ConversationRef } from "@vendeya/types";

const app = new Hono();

// The lookup returns one person's credit standing, so only VendeYa's own
// staff may run it. FNB answers through a tenant's own Cálidda login, so the
// caller names the tenant; without one the FNB leg reports it needs a tenant.
app.get("/:dni", requirePlatformOperator, async (c) => {
  const dni = pathParam(c, "dni");

  if (!/^\d{8}$/.test(dni)) {
    return c.json({ error: "DNI debe tener 8 dígitos" }, 400);
  }

  const tenantId = c.req.query("tenant");
  let ref: ConversationRef | undefined;
  if (tenantId) {
    const tenant = await TenantService.getById(tenantId);
    if (!tenant) {
      return c.json({ error: "Negocio no encontrado" }, 404);
    }
    ref = { tenantId: tenant.id, channelAccountId: "", phoneNumber: "" };
  }

  try {
    const result = await eligibilityHandler.execute(dni, ref);
    const healthStatus = await getAllStatus(ref?.tenantId);

    return c.json({
      dni,
      result: isOk(result) ? result.value : { error: result.error.message },
      // A missing login reads as a system outage, so say plainly why the FNB
      // leg could not answer.
      fnb: ref
        ? undefined
        : { status: "unavailable", reason: "FNB requires a tenant" },
      providersChecked: [
        ...(healthStatus.fnb.available ? ["fnb"] : []),
        ...(healthStatus.gaso.available ? ["gaso"] : []),
      ],
    });
  } catch (_error) {
    return c.json({ error: "Error al consultar proveedor" }, 500);
  }
});

export default app;
