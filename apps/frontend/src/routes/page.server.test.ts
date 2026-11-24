/// <reference types="bun" />

import { describe, it, expect } from "bun:test";
import { load } from "./+page.server.ts";

describe("the landing page route", () => {
  it("sends a signed-in user to /dashboard", () => {
    try {
      load({ locals: { user: { role: "admin" } } } as never);
    } catch (thrown) {
      const t = thrown as { status: number; location?: string };
      expect(t).toEqual({ status: 303, location: "/dashboard" });
      return;
    }
    throw new Error("load returned without redirecting");
  });

  it("renders for a visitor without a session", () => {
    expect(load({ locals: { user: null } } as never)).toBeUndefined();
  });
});
