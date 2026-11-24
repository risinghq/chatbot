import type { Customer, CustomerAddress, OrderSummary } from "@vendeya/types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, cookies, fetch }) => {
  const sessionToken = cookies.get("session");
  if (!sessionToken) return { customer: null, addresses: [], orders: [] };
  const headers = { cookie: `session=${sessionToken}` };
  const id = params.customerId;

  const [customerRes, addressesRes, ordersRes, optOutRes] = await Promise.all([
    fetch(`/api/customers/${id}`, { headers }),
    fetch(`/api/customers/${id}/addresses`, { headers }),
    fetch(`/api/orders?customer_id=${encodeURIComponent(id)}`, { headers }),
    fetch(`/api/campaigns/customers/${id}/opt-out`, { headers }),
  ]);
  return {
    customer: customerRes.ok ? await customerRes.json<Customer>() : null,
    addresses: addressesRes.ok
      ? await addressesRes.json<CustomerAddress[]>()
      : [],
    orders: ordersRes.ok ? await ordersRes.json<OrderSummary[]>() : [],
    optedOut: optOutRes.ok
      ? (await optOutRes.json<{ optedOut: boolean }>()).optedOut
      : false,
  };
};
