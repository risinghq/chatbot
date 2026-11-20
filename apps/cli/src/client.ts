import type { Credentials } from "./credentials.ts";

/** A refusal from the server, carrying its status and parsed body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${status}`;
    super(detail);
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Sends one request to the VendeYa API as the token's owner. The answer is the
 * parsed JSON body; any status outside 2xx throws ApiError.
 */
export async function callApi(
  credentials: Credentials,
  method: string,
  apiPath: string,
  body?: unknown,
  fetcher: Fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(`${credentials.url}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      Accept: "application/json",
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body, such as a proxy's error page, is reported as text.
  }
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed;
}
