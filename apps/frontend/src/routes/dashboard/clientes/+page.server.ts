import type { CustomerSummary } from "@vendeya/types";
import type { PageServerLoad } from "./$types";

/** The list reads at most this many; a search narrows it. */
const LIMIT = 100;

export const load: PageServerLoad = async ({ url, cookies, fetch }) => {
  const search = url.searchParams.get("q") ?? "";
  const sessionToken = cookies.get("session");
  if (!sessionToken) return { customers: [], search, limit: LIMIT };

  const params = new URLSearchParams({ limit: String(LIMIT) });
  if (search) params.set("search", search);
  const res = await fetch(`/api/customers?${params}`, {
    headers: { cookie: `session=${sessionToken}` },
  });
  const customers = res.ok ? await res.json<CustomerSummary[]>() : [];
  return { customers, search, limit: LIMIT };
};
