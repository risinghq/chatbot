import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { run } from "../src/db/index.ts";
import { TEST_BINDINGS } from "./bindings.ts";
import { backendFetch } from "./helpers/turn.ts";
import { logsDuring } from "./helpers/logs.ts";

afterEach(() => {
  env.ENVIRONMENT = TEST_BINDINGS.ENVIRONMENT;
  env.PUBLIC_URL = TEST_BINDINGS.PUBLIC_URL;
});

describe("the API's CORS origin", () => {
  it.each([
    ["PUBLIC_URL", "https://ventas.example.com", "https://ventas.example.com"],
    [
      "PUBLIC_URL without its trailing slash",
      "https://ventas.example.com/",
      "https://ventas.example.com",
    ],
    ["localhost when PUBLIC_URL is empty", "", "http://localhost:5173"],
  ])("is %s", async (_name, publicUrl, origin) => {
    env.ENVIRONMENT = "production";
    env.PUBLIC_URL = publicUrl;

    const response = await backendFetch("/api/conversations", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "GET" },
    });

    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
  });
});

describe("the simulator routes", () => {
  it("are mounted in production and ask for a session", async () => {
    env.ENVIRONMENT = "production";

    for (const path of [
      "/api/simulator/conversations",
      "/api/simulator/conversation/51999999999",
    ]) {
      expect((await backendFetch(path)).status, path).toBe(401);
    }
  });
});

describe("a sweep task that throws", () => {
  it("is logged by name, and the other tasks still run", async () => {
    await run("DROP TABLE message_inbox");
    const topOfHour = Date.UTC(2026, 10, 17, 10, 0, 0);

    const logs = await logsDuring("error", async () => {
      const ctx = createExecutionContext();
      await worker.scheduled(
        createScheduledController({
          scheduledTime: topOfHour,
          cron: "* * * * *",
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
    });

    expect(
      logs
        .filter((entry) => entry.message === "Scheduled task failed")
        .map((entry) => entry.task)
        .sort(),
    ).toEqual(["purge processed messages", "wake conversations"]);
  });
});
