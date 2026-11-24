import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

const HISTORY_ROLES = ["admin", "developer", "supervisor"];

export const load: PageServerLoad = ({ locals, params }) => {
  if (!locals.user?.role || !HISTORY_ROLES.includes(locals.user.role)) {
    redirect(303, `/dashboard/${params.tenantId}`);
  }
};
