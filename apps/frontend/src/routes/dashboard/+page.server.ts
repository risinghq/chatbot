import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

type Tenant = { id: string; name: string; ai_configured?: boolean };

/**
 * /dashboard holds no business, so it opens one: the business last opened,
 * else a member's only business, else the list to pick from.
 */
export const load: PageServerLoad = async ({ locals, fetch }) => {
  const res = await fetch("/api/tenants").catch(() => null);
  const data = res?.ok
    ? await res.json<{ tenants: Tenant[]; activeTenantId: string | null }>()
    : { tenants: [], activeTenantId: null };
  const pinned = data.tenants.find((t) => t.id === data.activeTenantId);
  if (pinned) redirect(303, `/dashboard/${pinned.id}`);
  const only = data.tenants.length === 1 ? data.tenants[0] : undefined;
  if (only && !locals.user?.isPlatformOperator) {
    redirect(303, `/dashboard/${only.id}`);
  }
  return { tenants: data.tenants };
};
