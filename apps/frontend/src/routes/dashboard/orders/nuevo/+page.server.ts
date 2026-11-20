import type {
  Customer,
  CustomerAddress,
  DeliveryZone,
  StockLocation,
  StockRow,
} from "@vendeya/types";
import type { PageServerLoad } from "./$types";

const EMPTY = {
  locations: [] as StockLocation[],
  stock: [] as StockRow[],
  zones: [] as DeliveryZone[],
  customer: null as Customer | null,
  addresses: [] as CustomerAddress[],
};

export const load: PageServerLoad = async ({ cookies, fetch, url }) => {
  const sessionToken = cookies.get("session");
  if (!sessionToken) return EMPTY;
  const headers = { cookie: `session=${sessionToken}` };
  const read = async <T>(path: string, fallback: T): Promise<T> => {
    const res = await fetch(path, { headers });
    return res.ok ? await res.json<T>() : fallback;
  };

  const customerId = url.searchParams.get("customer");
  const [locations, zones, customer, addresses] = await Promise.all([
    read<StockLocation[]>("/api/stock/locations", []),
    read<DeliveryZone[]>("/api/delivery-zones", []),
    customerId
      ? read<Customer | null>(
          `/api/customers/${encodeURIComponent(customerId)}`,
          null,
        )
      : null,
    customerId
      ? read<CustomerAddress[]>(
          `/api/customers/${encodeURIComponent(customerId)}/addresses`,
          [],
        )
      : [],
  ]);

  // With several locations the order names one, so the page starts on the
  // first and reads its stock.
  const first = locations.length > 1 ? locations[0] : undefined;
  const stockPath = first
    ? `/api/stock?location_id=${encodeURIComponent(first.id)}`
    : "/api/stock";
  return {
    locations,
    stock: await read<StockRow[]>(stockPath, []),
    zones: zones.filter((z) => z.is_active),
    customer,
    addresses: customer ? addresses : [],
  };
};
