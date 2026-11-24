import { Hono } from "hono";
import { TaypiCharges } from "../domains/payments/charges.ts";
import { tellCustomerPaid } from "../domains/payments/notify.ts";
import { createLogger } from "../lib/logger.ts";
import { pathParam } from "../lib/http.ts";

const logger = createLogger("pay");

/**
 * The customer's pay link, with no login: the charge id in the link is the
 * credential, as for any payment link.
 */
const pay = new Hono();

pay.get("/:chargeId", async (c) => {
  const page = await TaypiCharges.payPage(pathParam(c, "chargeId"));
  if (!page) return c.json({ error: "Pay link not found" }, 404);
  return c.json(page);
});

/**
 * The pay page asks after checkout.js reports a payment, so the customer sees
 * it confirmed even when TAYPI's webhook has not arrived.
 */
pay.post("/:chargeId/check", async (c) => {
  const chargeId = pathParam(c, "chargeId");
  const charge = await TaypiCharges.get(chargeId);
  if (!charge) return c.json({ error: "Pay link not found" }, 404);
  try {
    const settled = await TaypiCharges.check(charge);
    if (settled) await tellCustomerPaid(settled.order, settled.paidCents);
  } catch (error) {
    logger.warn({ error, chargeId }, "TAYPI status check failed");
  }
  return c.json(await TaypiCharges.payPage(chargeId));
});

export default pay;
