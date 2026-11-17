import type { Handle } from "@sveltejs/kit/hooks";
import { env } from "cloudflare:workers";

/**
 * The backend answers /api and /media. In production its Worker routes catch
 * those paths before this Worker runs. A server load's fetch of /api, and
 * every such request under `vite dev` or `wrangler dev`, arrives here and goes
 * to the backend through the service binding.
 */
function isBackendPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/media/");
}

export const handle: Handle = async ({ event, resolve }) => {
  if (isBackendPath(event.url.pathname)) {
    return env.BACKEND.fetch(event.request);
  }

  const sessionToken = event.cookies.get("session");
  if (sessionToken) {
    const response = await env.BACKEND.fetch(
      new URL("/api/auth/me", event.url),
      { headers: { cookie: `session=${sessionToken}` } },
    ).catch(() => null);

    if (response?.ok) {
      const data = await response.json<{ user: App.Locals["user"] }>();
      event.locals.user = data.user;
    }
  }

  if (event.url.pathname.startsWith("/dashboard") && !event.locals.user) {
    return new Response(null, {
      status: 302,
      headers: { location: "/login" },
    });
  }

  return resolve(event);
};
