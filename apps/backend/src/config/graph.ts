import { env } from "cloudflare:workers";

export const DEFAULT_GRAPH_VERSION = "v26.0";
export const DEFAULT_GRAPH_BASE_URL = "https://graph.facebook.com";
export const DEFAULT_INSTAGRAM_GRAPH_BASE_URL = "https://graph.instagram.com";

const VERSION_PATTERN = /^v\d+\.\d+$/;

function graphVersion(): string {
  const version = env.GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      `GRAPH_API_VERSION must look like "v26.0", got "${version}"`,
    );
  }
  return version;
}

function originOf(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL: "${raw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be http(s), got "${raw}"`);
  }
  return url.origin;
}

export function graphConfig(): { baseUrl: string; version: string } {
  const version = graphVersion();
  const baseUrl = originOf(
    "GRAPH_API_BASE_URL",
    env.GRAPH_API_BASE_URL?.trim() || DEFAULT_GRAPH_BASE_URL,
  );
  return { baseUrl, version };
}

export function graphUrl(path: string): string {
  const { baseUrl, version } = graphConfig();
  return `${baseUrl}/${version}/${path.replace(/^\/+/, "")}`;
}

/**
 * Instagram accounts connected through Instagram Login are served from their
 * own host, on the same Graph versions.
 */
export function instagramGraphUrl(path: string): string {
  const version = graphVersion();
  const baseUrl = originOf(
    "INSTAGRAM_GRAPH_BASE_URL",
    env.INSTAGRAM_GRAPH_BASE_URL?.trim() || DEFAULT_INSTAGRAM_GRAPH_BASE_URL,
  );
  return `${baseUrl}/${version}/${path.replace(/^\/+/, "")}`;
}
