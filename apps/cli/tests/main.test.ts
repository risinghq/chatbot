import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, type Io } from "../src/main.ts";

type Sent = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "vendeya-cli-"));
});
afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function harness(options: {
  env?: Record<string, string>;
  stdin?: string;
  reply?: (sent: Sent) => { status?: number; body: unknown };
}) {
  const sent: Sent[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env: { XDG_CONFIG_HOME: configDir, ...options.env },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: async () => options.stdin ?? "",
    fetcher: async (url, init) => {
      const request: Sent = {
        url,
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      sent.push(request);
      const { status = 200, body } = options.reply?.(request) ?? {
        body: { ok: true },
      };
      return new Response(JSON.stringify(body), { status });
    },
  };
  return {
    io,
    sent,
    out: () => JSON.parse(out.join("")),
    err: () => JSON.parse(err.join("")),
  };
}

const AUTHED = { VENDEYA_TOKEN: "vy_test", VENDEYA_URL: "http://local/" };

describe("vendeya", () => {
  test("sends the token as a bearer and prints the answer as JSON", async () => {
    const h = harness({ env: AUTHED, reply: () => ({ body: [{ id: "t1" }] }) });
    expect(await main(["businesses", "list"], h.io)).toBe(0);
    expect(h.sent[0]?.url).toBe("http://local/api/tenants");
    expect(h.sent[0]?.headers.Authorization).toBe("Bearer vy_test");
    expect(h.out()).toEqual([{ id: "t1" }]);
  });

  test("creates a business by name", async () => {
    const h = harness({ env: AUTHED });
    expect(await main(["businesses", "create", "--name", "Tienda"], h.io)).toBe(
      0,
    );
    expect(h.sent[0]).toMatchObject({
      method: "POST",
      body: { name: "Tienda" },
    });
  });

  test("`businesses use none` clears the active business", async () => {
    const h = harness({ env: AUTHED });
    expect(await main(["businesses", "use", "none"], h.io)).toBe(0);
    expect(h.sent[0]?.body).toEqual({ tenantId: null });
  });

  test("a refusal exits 1 with the server's error", async () => {
    const h = harness({
      env: AUTHED,
      reply: () => ({ status: 403, body: { error: "Forbidden" } }),
    });
    expect(await main(["businesses", "create", "--name", "X"], h.io)).toBe(1);
    expect(h.err()).toMatchObject({ error: "Forbidden", status: 403 });
  });

  test("refuses to run without a login", async () => {
    const h = harness({});
    expect(await main(["whoami"], h.io)).toBe(2);
    expect(h.sent).toHaveLength(0);
  });

  test("a destructive command needs --yes", async () => {
    const h = harness({ env: AUTHED });
    expect(await main(["tokens", "revoke", "abc"], h.io)).toBe(2);
    expect(await main(["api", "DELETE", "/api/admin/users/u1"], h.io)).toBe(2);
    expect(h.sent).toHaveLength(0);
    expect(await main(["tokens", "revoke", "abc", "--yes"], h.io)).toBe(0);
    expect(h.sent[0]).toMatchObject({ method: "DELETE" });
  });

  test("settings set refuses a secret, which must come through stdin", async () => {
    const h = harness({ env: AUTHED });
    expect(await main(["settings", "set", "openai_api_key=sk-x"], h.io)).toBe(
      2,
    );
    expect(h.sent).toHaveLength(0);
  });

  test("secrets set reads stdin and never echoes the value", async () => {
    const h = harness({
      env: AUTHED,
      stdin: "sk-secret",
      reply: () => ({ body: { openai_api_key: "sk-secret", rejected: [] } }),
    });
    expect(await main(["secrets", "set", "openai_api_key"], h.io)).toBe(0);
    expect(h.sent[0]?.body).toEqual({ openai_api_key: "sk-secret" });
    expect(JSON.stringify(h.out())).not.toContain("sk-secret");
  });

  test("simulate say writes as the customer and prints only the new replies", async () => {
    const h = harness({
      env: AUTHED,
      reply: (sent) =>
        sent.method === "POST"
          ? { body: { status: "processed" } }
          : {
              body: {
                conversation: { phase: { phase: "greeting" }, id: "x" },
                messages: [
                  {
                    direction: "inbound",
                    type: "text",
                    content: "hola",
                    id: 1,
                  },
                  { direction: "outbound", type: "text", content: "¡Hola!" },
                  { direction: "inbound", type: "text", content: "precio" },
                  { direction: "outbound", type: "text", content: "S/ 800" },
                ],
              },
            },
    });
    const code = await main(
      ["simulate", "say", "51900000001", "cuánto", "cuesta"],
      h.io,
    );
    expect(code).toBe(0);
    expect(h.sent[0]).toMatchObject({
      method: "POST",
      url: "http://local/api/simulator/message",
      body: { phoneNumber: "51900000001", message: "cuánto cuesta" },
    });
    expect(h.out()).toEqual({
      phase: { phase: "greeting" },
      replies: [{ direction: "outbound", type: "text", content: "S/ 800" }],
    });
  });

  test("api passes JSON through", async () => {
    const h = harness({ env: AUTHED });
    const code = await main(
      ["api", "post", "/api/admin/invitations", "--data", '{"email":"a@b.c"}'],
      h.io,
    );
    expect(code).toBe(0);
    expect(h.sent[0]).toMatchObject({
      method: "POST",
      body: { email: "a@b.c" },
    });
  });

  test("login checks the token before storing it, owner-readable only", async () => {
    const h = harness({
      stdin: "vy_new",
      reply: () => ({ body: { email: "x" } }),
    });
    expect(await main(["login", "--url", "http://local"], h.io)).toBe(0);
    const file = path.join(configDir, "vendeya", "credentials.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      url: "http://local",
      token: "vy_new",
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(h.out())).not.toContain("vy_new");

    const after = harness({});
    expect(await main(["whoami"], after.io)).toBe(0);
    expect(after.sent[0]?.headers.Authorization).toBe("Bearer vy_new");
  });

  test("stock adjust finds the variant by SKU and takes a negative quantity after --", async () => {
    const h = harness({
      env: AUTHED,
      reply: (sent) =>
        sent.method === "GET"
          ? { body: [{ variant_id: "v1", sku: "POLO-M" }] }
          : { status: 201, body: { id: "m1" } },
    });
    const code = await main(
      ["stock", "adjust", "POLO-M", "--note", "conteo", "--", "-2"],
      h.io,
    );
    expect(code).toBe(0);
    expect(h.sent[1]).toMatchObject({
      method: "POST",
      url: "http://local/api/stock/movements",
      body: { variant_id: "v1", kind: "adjust", quantity: -2, note: "conteo" },
    });
  });

  test("stock receive refuses an unknown SKU before writing", async () => {
    const h = harness({ env: AUTHED, reply: () => ({ body: [] }) });
    expect(await main(["stock", "receive", "NOPE", "3"], h.io)).toBe(2);
    expect(h.sent.map((s) => s.method)).toEqual(["GET"]);
  });

  test("variants add sends amounts in cents", async () => {
    const h = harness({ env: AUTHED });
    const code = await main(
      [
        "variants",
        "add",
        "p1",
        "POLO-M",
        "49,90",
        "--cost",
        "21",
        "--name",
        "M",
      ],
      h.io,
    );
    expect(code).toBe(0);
    expect(h.sent[0]?.body).toEqual({
      sku: "POLO-M",
      price_cents: 4990,
      cost_cents: 2100,
      name: "M",
    });
    expect(await main(["variants", "add", "p1", "X", "4.999"], h.io)).toBe(2);
  });

  test("a rejected token is not stored", async () => {
    const h = harness({
      stdin: "vy_bad",
      reply: () => ({ status: 401, body: { error: "Unauthorized" } }),
    });
    expect(await main(["login"], h.io)).toBe(1);
    expect(
      await stat(path.join(configDir, "vendeya", "credentials.json")).catch(
        () => null,
      ),
    ).toBeNull();
  });
});
