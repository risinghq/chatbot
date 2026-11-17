/**
 * `/api/health` is what an uptime check reads. It answers 503 when the
 * database does not answer, and 200 otherwise.
 */

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { markBlocked } from "../src/adapters/providers/health.ts";
import { backendFetch } from "./helpers/turn.ts";

const DB = env.DB;

afterEach(async () => {
  env.DB = DB;
});

describe("/api/health", () => {
  it("answers 200, then 503 after the database stops answering", async () => {
    const healthyResponse = await backendFetch("/api/health");

    expect(healthyResponse.status).toBe(200);
    expect(await healthyResponse.json()).toMatchObject({
      status: "healthy",
      database: { status: "healthy" },
    });

    env.DB = {
      prepare: () => {
        throw new Error("D1 is unreachable");
      },
    } as unknown as D1Database;

    const unavailableResponse = await backendFetch("/api/health");

    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toMatchObject({
      status: "unavailable",
      database: { status: "unavailable" },
    });
  });

  it("stays 200 and reports degraded while a provider is blocked", async () => {
    await markBlocked("gaso", "upstream timeout");

    const response = await backendFetch("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "degraded" });
  });
});
