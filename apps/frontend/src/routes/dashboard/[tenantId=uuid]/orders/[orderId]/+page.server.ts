import type { OrderDetail, PaymentMethod } from "@vendeya/types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, cookies, fetch }) => {
  const sessionToken = cookies.get("session");
  if (!sessionToken) {
    return { order: null, methods: [] };
  }
  const headers = { cookie: `session=${sessionToken}` };

  try {
    const [orderRes, methodsRes] = await Promise.all([
      fetch(`/api/orders/${params.orderId}`, { headers }),
      fetch("/api/payment-methods", { headers }),
    ]);
    const order = orderRes.ok ? await orderRes.json<OrderDetail>() : null;
    const methods = methodsRes.ok
      ? (await methodsRes.json<PaymentMethod[]>()).filter((m) => m.is_active)
      : [];
    return { order, methods };
  } catch {
    return { order: null, methods: [] };
  }
};
