import type { DeliveryZone, PaymentMethod } from "@vendeya/types";
import type { TaypiStatus } from "#lib/components/orders/taypi-connection.svelte";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ cookies, fetch }) => {
  const sessionToken = cookies.get("session");
  if (!sessionToken) return { zones: [], methods: [], taypi: null };
  const headers = { cookie: `session=${sessionToken}` };

  const [zonesRes, methodsRes, taypiRes] = await Promise.all([
    fetch("/api/delivery-zones", { headers }),
    fetch("/api/payment-methods", { headers }),
    fetch("/api/admin/taypi", { headers }),
  ]);
  return {
    zones: zonesRes.ok ? await zonesRes.json<DeliveryZone[]>() : [],
    methods: methodsRes.ok ? await methodsRes.json<PaymentMethod[]>() : [],
    taypi: taypiRes.ok ? await taypiRes.json<TaypiStatus>() : null,
  };
};
