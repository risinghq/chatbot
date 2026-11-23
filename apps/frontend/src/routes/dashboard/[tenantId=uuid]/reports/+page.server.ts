import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";

const REPORT_ROLES = ["admin", "developer", "supervisor"];

export const load: PageServerLoad = async ({ locals, fetch, params }) => {
  if (!locals.user?.role || !REPORT_ROLES.includes(locals.user.role)) {
    redirect(303, `/dashboard/${params.tenantId}`);
  }

  const res = await fetch("/api/reports/today-count").catch(() => null);
  const data = res?.ok ? await res.json<{ count: number }>() : null;
  return { todayCount: data?.count ?? 0 };
};
