import { error, redirect } from "@sveltejs/kit";
import { isBusinessId } from "../../../params.ts";
import type { PageServerLoad } from "./$types";

/**
 * A link from before the business was in the URL, such as /dashboard/orders/42
 * in an alert already sent on WhatsApp. It opens in the business last opened;
 * with none, the picker. A path that already names a business is a page that
 * does not exist: prefixing the business again would redirect forever.
 */
export const load: PageServerLoad = ({ locals, params, url }) => {
  const [first = ""] = params.path.split("/");
  if (isBusinessId(first)) {
    error(404, "Esta página no existe.");
  }
  const business = locals.user?.lastTenantId;
  if (!business) redirect(303, "/dashboard");
  redirect(303, `/dashboard/${business}/${params.path}${url.search}`);
};
