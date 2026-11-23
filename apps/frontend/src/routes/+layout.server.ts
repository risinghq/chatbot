import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, params }) => {
  // The user's role depends on the business in the URL (hooks.server.ts), so
  // the load names the param and reruns when the business changes.
  void params.tenantId;
  return {
    user: locals.user ?? null,
  };
};
