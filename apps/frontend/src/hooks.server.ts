import type { Handle, HandleFetch } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";
import { TENANT_HEADER } from "#lib/utils/api.js";

/**
 * The backend answers /api and /media. In production its Worker routes catch
 * those paths before this Worker runs. A server load's fetch of /api, and
 * every such request under `vite dev` or `wrangler dev`, arrives here and goes
 * to the backend through the service binding.
 */
function isBackendPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/media/");
}

const redirectTo = (location: string) =>
  new Response(null, { status: 302, headers: { location } });

export const handle: Handle = async ({ event, resolve }) => {
  if (isBackendPath(event.url.pathname)) {
    return env.BACKEND.fetch(event.request);
  }

  // A page under /dashboard/[tenantId] acts in that business. The session is
  // read in it, so `locals.user` carries the role the user has there.
  const business = event.params.tenantId ?? null;

  const sessionToken = event.cookies.get("session");
  if (sessionToken) {
    const headers: Record<string, string> = {
      cookie: `session=${sessionToken}`,
    };
    if (business) headers[TENANT_HEADER] = business;
    const response = await env.BACKEND.fetch(
      new URL("/api/auth/me", event.url),
      { headers },
    ).catch(() => null);

    // The business does not exist, is closed, or is not the user's.
    if (business && response?.status === 404) return redirectTo("/dashboard");

    if (response?.ok) {
      const data = await response.json<{ user: App.Locals["user"] }>();
      event.locals.user = data.user;
    }
  }

  if (event.url.pathname.startsWith("/dashboard") && !event.locals.user) {
    return redirectTo("/login");
  }

  return resolve(event);
};

/** A server load's request to the backend names the page's business. */
export const handleFetch: HandleFetch = ({ event, request, fetch }) => {
  const business = event.params.tenantId;
  const url = new URL(request.url);
  if (
    business &&
    url.origin === event.url.origin &&
    url.pathname.startsWith("/api/") &&
    !request.headers.has(TENANT_HEADER)
  ) {
    request.headers.set(TENANT_HEADER, business);
  }
  return fetch(request);
};
