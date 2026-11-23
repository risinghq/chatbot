type FetchOptions = RequestInit & {
  params?: Record<string, string>;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The header that names the business a request acts in. */
export const TENANT_HEADER = "X-Tenant-Id";

const BUSINESS_PATH =
  /^\/dashboard\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** The business a dashboard path is in, or null outside one. */
export function businessInPath(pathname: string): string | null {
  return BUSINESS_PATH.exec(pathname)?.[1] ?? null;
}

/**
 * `fetch` for the backend. In the browser a request names the business of the
 * page it comes from, so two tabs can work in two businesses. A server load
 * gets the same header from `handleFetch` in hooks.server.ts.
 */
export function apiFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const business =
    typeof window === "undefined"
      ? null
      : businessInPath(window.location.pathname);
  if (!business) return fetch(url, init);
  const headers = new Headers(init.headers);
  if (!headers.has(TENANT_HEADER)) headers.set(TENANT_HEADER, business);
  return fetch(url, { ...init, headers });
}

export async function fetchApi<T>(
  endpoint: string,
  options: FetchOptions = {},
): Promise<T> {
  const { params, ...init } = options;

  let url = endpoint;
  if (params) {
    const query = new URLSearchParams(params).toString();
    url = `${endpoint}?${query}`;
  }

  const response = await apiFetch(url, init);

  if (!response.ok) {
    const error = await response
      .json<{ error?: string }>()
      .catch(() => ({ error: "Request failed" }));
    throw new ApiError(
      error.error || `HTTP ${response.status}`,
      response.status,
    );
  }

  return response.json<T>();
}

export function createFormData(data: Record<string, any>): FormData {
  const form = new FormData();

  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) {
      if (value instanceof File) {
        form.append(key, value);
      } else if (typeof value === "object") {
        form.append(key, JSON.stringify(value));
      } else {
        form.append(key, String(value));
      }
    }
  }

  return form;
}
