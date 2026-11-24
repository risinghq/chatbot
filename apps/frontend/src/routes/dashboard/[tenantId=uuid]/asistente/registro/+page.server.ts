import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/** A prompt holds the customer's messages, so only the people who tune the assistant read it. */
export const load: PageServerLoad = ({ locals, params }) => {
  if (locals.user?.role !== "admin" && locals.user?.role !== "developer") {
    redirect(303, `/dashboard/${params.tenantId}/asistente`);
  }
};
