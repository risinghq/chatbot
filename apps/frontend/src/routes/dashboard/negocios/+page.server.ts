import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) {
    redirect(307, "/login");
  }

  // Creating businesses and granting memberships is platform-operator work.
  if (!locals.user.isPlatformOperator) {
    redirect(303, "/dashboard");
  }

  return { user: locals.user };
};
