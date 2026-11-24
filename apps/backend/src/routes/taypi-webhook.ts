import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TaypiCharges } from "../domains/payments/charges.ts";
import { tellCustomerPaid } from "../domains/payments/notify.ts";
import { taypiKeys, taypiSignatureMatches } from "../domains/payments/taypi.ts";
import { createLogger } from "../lib/logger.ts";
import { pathParam } from "../lib/http.ts";

const logger = createLogger("taypi-webhook");

/**
 * TAYPI's payment events for one business. The path names the business
 * because each signs with its own webhook secret.
 */
const taypiWebhook = new Hono();

type PaymentEvent = {
  event?: string;
  payment_id?: string;
  amount?: string;
  reference?: string | null;
  payer_display_name?: string | null;
};

taypiWebhook.post(
  "/:tenantId",
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }),
  async (c) => {
    const tenantId = pathParam(c, "tenantId");
    const raw = await c.req.text();
    const keys = await taypiKeys(tenantId);
    if (
      !keys ||
      !(await taypiSignatureMatches(
        raw,
        c.req.header("taypi-signature") ?? null,
        keys.webhookSecret,
      ))
    ) {
      logger.warn({ tenantId }, "TAYPI webhook refused: bad signature");
      return c.json({ error: "invalid_signature" }, 401);
    }

    let event: PaymentEvent;
    try {
      event = JSON.parse(raw) as PaymentEvent;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    // TAYPI retries anything but a 2xx, so an event that names no charge of
    // this business is acknowledged and dropped.
    const charge = event.reference
      ? await TaypiCharges.get(event.reference)
      : null;
    if (!charge || charge.tenant_id !== tenantId) {
      logger.info(
        { tenantId, event: event.event },
        "TAYPI event for no charge of ours",
      );
      return c.json({ received: true });
    }

    if (event.event === "payment.completed" && event.payment_id) {
      const settled = await TaypiCharges.settle(tenantId, charge.id, {
        paymentId: event.payment_id,
        amount: event.amount ?? "0",
        payerName: event.payer_display_name ?? null,
      });
      if (settled) await tellCustomerPaid(settled.order, settled.paidCents);
    } else if (event.event === "payment.expired") {
      await TaypiCharges.close(tenantId, charge.id, "expired");
    } else if (event.event === "payment.failed") {
      await TaypiCharges.close(tenantId, charge.id, "failed");
    }
    return c.json({ received: true });
  },
);

export default taypiWebhook;
