/// <reference types="bun" />

import { describe, it, expect, afterEach } from "bun:test";
import { businessInPath, fetchApi } from "./api.ts";

const realFetch = globalThis.fetch;

describe("fetchApi", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("carries the HTTP status on the error it throws", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      })) as unknown as typeof fetch;

    const error = (await fetchApi("/api/providers/12345678").catch(
      (e) => e,
    )) as Error & { status?: number };

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Forbidden");
    expect(error.status).toBe(403);
  });
});

describe("the business a page is in", () => {
  const id = "01a20963-f53c-759c-97bb-c737ff94f6cc";

  it("is the id after /dashboard, on the home and below it", () => {
    expect(businessInPath(`/dashboard/${id}`)).toBe(id);
    expect(businessInPath(`/dashboard/${id}/orders/42`)).toBe(id);
  });

  it("is none on the picker and the platform pages", () => {
    expect(businessInPath("/dashboard")).toBeNull();
    expect(businessInPath("/dashboard/negocios")).toBeNull();
    expect(businessInPath("/dashboard/reports")).toBeNull();
  });

  it("is none when the id only starts the segment", () => {
    expect(businessInPath(`/dashboard/${id}x/orders`)).toBeNull();
  });
});
