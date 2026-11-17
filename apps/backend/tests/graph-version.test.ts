import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { ChannelAccount } from "@vendeya/types";

import { CloudApiAdapter } from "../src/adapters/whatsapp/cloud-api.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { DEFAULT_GRAPH_VERSION, graphConfig } from "../src/config/graph.ts";
import { TEST_BINDINGS } from "./bindings.ts";
import { createTenantFixture } from "./helpers/tenancy.ts";

const CUSTOMER = "51900333444";
const TOKEN = "EAAG-graph-version-token";

type Seen = {
  method: string;
  origin: string;
  path: string;
  auth: string | null;
  body: unknown;
};

/** The Graph variables, restored after each test from the test bindings. */
const vars = env as unknown as {
  GRAPH_API_VERSION?: string;
  GRAPH_API_BASE_URL?: string;
};

afterEach(async () => {
  delete vars.GRAPH_API_VERSION;
  vars.GRAPH_API_BASE_URL = TEST_BINDINGS.GRAPH_API_BASE_URL;
});

describe("the Graph version of a send", () => {
  let account: ChannelAccount;
  let originalFetch: typeof globalThis.fetch;
  let seen: Seen[];

  beforeEach(async () => {
    delete vars.GRAPH_API_VERSION;
    seen = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        origin: url.origin,
        path: url.pathname,
        auth: request.headers.get("authorization"),
        body: await request.json(),
      });
      return Response.json({ messages: [{ id: "wamid.FAKE" }] });
    }) as typeof globalThis.fetch;

    const tenant = await createTenantFixture("graph-version");
    account = await ChannelAccountService.create({
      tenantId: tenant.tenantId,
      phoneNumberId: "pnid-graph",
      accessToken: TOKEN,
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
  });

  it("sends a text to the default version", async () => {
    const outcome = await CloudApiAdapter.sendMessage(
      account,
      CUSTOMER,
      "hola",
    );

    expect(outcome).toEqual({ ok: true, messageId: "wamid.FAKE" });
    expect(DEFAULT_GRAPH_VERSION).toBe("v26.0");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      origin: TEST_BINDINGS.GRAPH_API_BASE_URL,
      path: "/v26.0/pnid-graph/messages",
      auth: `Bearer ${TOKEN}`,
      body: { messaging_product: "whatsapp", to: CUSTOMER, type: "text" },
    });
  });

  it("sends an image and a read receipt to the configured version", async () => {
    vars.GRAPH_API_VERSION = "v25.0";

    await CloudApiAdapter.sendImage(account, CUSTOMER, "images/a.jpg");
    await CloudApiAdapter.markAsRead(account, "wamid.IN", { typing: true });

    expect(seen.map((s) => s.path)).toEqual([
      "/v25.0/pnid-graph/messages",
      "/v25.0/pnid-graph/messages",
    ]);
    expect(seen[1]!.body).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.IN",
      typing_indicator: { type: "text" },
    });
  });

  it("reads the version at each send", async () => {
    await CloudApiAdapter.sendMessage(account, CUSTOMER, "uno");
    vars.GRAPH_API_VERSION = "v24.0";
    await CloudApiAdapter.sendMessage(account, CUSTOMER, "dos");

    expect(seen.map((s) => s.path.split("/")[1])).toEqual(["v26.0", "v24.0"]);
  });
});

describe("the Graph settings", () => {
  beforeEach(async () => {
    delete vars.GRAPH_API_VERSION;
    delete vars.GRAPH_API_BASE_URL;
  });

  it("default to Meta's host and the latest version", async () => {
    expect(graphConfig()).toEqual({
      baseUrl: "https://graph.facebook.com",
      version: "v26.0",
    });
  });

  it("treat an empty variable as unset", async () => {
    vars.GRAPH_API_VERSION = " ";
    expect(graphConfig().version).toBe("v26.0");
  });

  for (const version of ["26.0", "v26", "latest", "v26.0/../x", "V26.0"]) {
    it(`reject the version "${version}"`, async () => {
      vars.GRAPH_API_VERSION = version;
      expect(() => graphConfig()).toThrow("GRAPH_API_VERSION");
    });
  }

  for (const url of ["graph.facebook.com", "ftp://graph.facebook.com"]) {
    it(`reject the base URL "${url}"`, async () => {
      vars.GRAPH_API_BASE_URL = url;
      expect(() => graphConfig()).toThrow("GRAPH_API_BASE_URL");
    });
  }
});
