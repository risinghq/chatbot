import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

/** The platform area is VendeYa's own staff's. Anyone else goes to their business. */
export const load: LayoutServerLoad = ({ locals }) => {
  if (!locals.user?.isPlatformOperator) redirect(303, "/dashboard");
};
