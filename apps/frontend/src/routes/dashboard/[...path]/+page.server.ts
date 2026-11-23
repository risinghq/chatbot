import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/**
 * A link from before the business was in the URL, such as /dashboard/orders/42
 * in an alert already sent on WhatsApp. It opens in the business last opened;
 * with none, the picker.
 */
export const load: PageServerLoad = ({ locals, params, url }) => {
  const business = locals.user?.lastTenantId;
  if (!business) redirect(303, "/dashboard");
  redirect(303, `/dashboard/${business}/${params.path}${url.search}`);
};
