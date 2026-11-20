import type { OrderMetrics, OrderSummary } from "@vendeya/types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, cookies, fetch }) => {
  const sessionToken = cookies.get("session");
  if (!sessionToken) {
    return { orders: [], metrics: null };
  }

  const params = new URLSearchParams();
  for (const key of ["status", "startDate", "endDate"]) {
    const value = url.searchParams.get(key);
    if (value) params.append(key, value);
  }

  try {
    const [ordersRes, metricsRes] = await Promise.all([
      fetch(`/api/orders?${params.toString()}`, {
        headers: { cookie: `session=${sessionToken}` },
      }),
      fetch("/api/orders/metrics", {
        headers: { cookie: `session=${sessionToken}` },
      }),
    ]);

    const orders = ordersRes.ok ? await ordersRes.json<OrderSummary[]>() : [];
    const metrics = metricsRes.ok
      ? await metricsRes.json<OrderMetrics>()
      : null;

    return { orders, metrics };
  } catch {
    return { orders: [], metrics: null };
  }
};
