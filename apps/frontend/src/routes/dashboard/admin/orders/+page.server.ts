import type { DeliveryZone, PaymentMethod } from "@vendeya/types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ cookies, fetch }) => {
  const sessionToken = cookies.get("session");
  if (!sessionToken) return { zones: [], methods: [] };
  const headers = { cookie: `session=${sessionToken}` };

  const [zonesRes, methodsRes] = await Promise.all([
    fetch("/api/delivery-zones", { headers }),
    fetch("/api/payment-methods", { headers }),
  ]);
  return {
    zones: zonesRes.ok ? await zonesRes.json<DeliveryZone[]>() : [],
    methods: methodsRes.ok ? await methodsRes.json<PaymentMethod[]>() : [],
  };
};
