import { env } from "cloudflare:workers";

/**
 * The address the outside world reaches the dashboard at, with no trailing
 * slash: CORS compares the origin exactly, and links append a path. The
 * backend's routes share it, so it is also the origin of `/media`.
 */
export function publicOrigin(): string {
  return (env.PUBLIC_URL?.trim() || "http://localhost:5173").replace(
    /\/+$/,
    "",
  );
}

export function isProduction(): boolean {
  return env.ENVIRONMENT === "production";
}
