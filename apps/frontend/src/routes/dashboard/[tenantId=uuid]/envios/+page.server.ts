import type { OrderStatus, ShipmentSummary } from "@vendeya/types";
import type { PageServerLoad } from "./$types";

const OPEN: OrderStatus[] = ["pending", "confirmed", "packed", "shipped"];

/** Delivered shipments are history; the page shows only the latest. */
const RECENT_DELIVERED = 20;

export const load: PageServerLoad = async ({ cookies, fetch }) => {
  const sessionToken = cookies.get("session");
  if (!sessionToken) return { open: [], delivered: [] };

  const read = async (statuses: OrderStatus[], limit: number) => {
    const params = new URLSearchParams({
      status: statuses.join(","),
      limit: String(limit),
    });
    const res = await fetch(`/api/orders/shipments?${params}`, {
      headers: { cookie: `session=${sessionToken}` },
    });
    return res.ok ? await res.json<ShipmentSummary[]>() : [];
  };

  const [open, delivered] = await Promise.all([
    read(OPEN, 200),
    read(["delivered"], RECENT_DELIVERED),
  ]);
  return { open, delivered };
};
