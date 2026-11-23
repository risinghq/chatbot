import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) {
    redirect(307, "/login");
  }

  if (locals.user.role !== "admin") {
    redirect(303, `/dashboard/${params.tenantId}`);
  }
};
