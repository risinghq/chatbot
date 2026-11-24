import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/** Administración opens on its first tab. */
export const load: PageServerLoad = ({ params }) => {
  redirect(303, `/dashboard/${params.tenantId}/admin/users`);
};
