/// <reference types="bun" />

import { describe, it, expect } from "bun:test";
import { load } from "./+page.server.ts";

const BUSINESS = "01a20bb2-adc0-7082-a672-4d7eaa5186f4";

function outcome(path: string, lastTenantId: string | null = BUSINESS) {
  try {
    load({
      locals: { user: { lastTenantId } },
      params: { path },
      url: new URL(`https://x/dashboard/${path}`),
    } as never);
  } catch (thrown) {
    const t = thrown as { status: number; location?: string };
    return { status: t.status, location: t.location };
  }
  throw new Error("load returned without redirecting or failing");
}

describe("a dashboard path with no business", () => {
  it("opens an old link in the business last opened", () => {
    expect(outcome("orders/42")).toEqual({
      status: 303,
      location: `/dashboard/${BUSINESS}/orders/42`,
    });
  });

  it("opens the picker when no business was opened", () => {
    expect(outcome("orders/42", null)).toEqual({
      status: 303,
      location: "/dashboard",
    });
  });

  it("answers 404 for a missing page inside a business", () => {
    expect(outcome(`${BUSINESS}/shipments`)).toEqual({
      status: 404,
      location: undefined,
    });
  });
});
