/**
 * `bun run account ... --remote` writes through the Cloudflare HTTP API, not
 * wrangler's remote bindings, which Bun's fetch cannot run (oven-sh/bun#39247).
 * These spawn the real CLI against a local fake of that API and check the rows
 * and the ciphertext it receives — the same statements and the same
 * SECRETS_KEY encryption the local path uses.
 *
 * They run processes, not bindings, so `bun test` runs them and the Workers
 * pool leaves them out.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const BACKEND = join(import.meta.dirname, "..", "..");

const ACCOUNT_ID = "test-account";
const API_TOKEN = "test-token";
const SECRETS_KEY = "a".repeat(64);

const TENANT = {
  id: "tenant-1",
  slug: "totem",
  name: "Totem",
  status: "active",
  created_at: 0,
};

type ApiCall = {
  sql?: string;
  params?: unknown[];
  batch?: Array<{ sql?: string; params?: unknown[] }>;
};

const calls: ApiCall[] = [];
const channelAccounts = new Map<string, Record<string, unknown>>();

function insertColumns(sql: string): string[] {
  const list = /insert into \w+ \(([^)]*)\)/i.exec(sql)?.[1] ?? "";
  return list.split(",").map((column) => column.trim());
}

function d1Result(
  results: Record<string, unknown>[] = [],
  changes = 1,
): Record<string, unknown> {
  return {
    success: true,
    results,
    meta: {
      changes,
      last_row_id: 1,
      duration: 0,
      changed_db: true,
      rows_read: results.length,
      rows_written: changes,
      size_after: 0,
    },
  };
}

function respondTo(statement: {
  sql?: string;
  params?: unknown[];
}): Record<string, unknown> {
  const sql = statement.sql ?? "";
  const params = statement.params ?? [];
  const compact = sql.replace(/\s+/g, " ").toLowerCase();

  if (compact.startsWith("select")) {
    if (compact.includes("from tenants")) {
      if (compact.includes("where slug = ?"))
        return d1Result(params[0] === TENANT.slug ? [TENANT] : []);
      if (compact.includes("where id = ?"))
        return d1Result(params[0] === TENANT.id ? [TENANT] : []);
      if (!compact.includes("where")) return d1Result([TENANT]);
    }
    if (
      compact.includes("from channel_accounts") &&
      compact.includes("where id = ?")
    ) {
      const row = channelAccounts.get(String(params[0]));
      return d1Result(row ? [row] : []);
    }
    return d1Result([]);
  }

  if (compact.startsWith("insert into channel_accounts")) {
    const row = Object.fromEntries(
      insertColumns(sql).map((column, i) => [column, params[i]]),
    );
    channelAccounts.set(String(row.id), row);
  }
  return d1Result([]);
}

let server: Server;
let apiBase: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const answer = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };

    if (req.headers.authorization !== `Bearer ${API_TOKEN}`) {
      return answer(403, {
        success: false,
        errors: [{ code: 9109, message: "invalid token" }],
        messages: [],
      });
    }

    if (
      req.method === "POST" &&
      new RegExp(`^/accounts/${ACCOUNT_ID}/d1/database/[^/]+/query$`).test(
        req.url ?? "",
      )
    ) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as ApiCall;
        calls.push(body);
        const statements = body.batch ?? [
          { sql: body.sql, params: body.params ?? [] },
        ];
        answer(200, {
          success: true,
          errors: [],
          messages: [],
          result: statements.map(respondTo),
        });
      });
      return;
    }

    answer(404, {
      success: false,
      errors: [{ code: 404, message: `no route for ${req.method} ${req.url}` }],
      messages: [],
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

function remoteEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: API_TOKEN,
    CLOUDFLARE_API_BASE_URL: apiBase,
    SECRETS_KEY,
  };
}

function statements(from = calls): Array<{ sql: string; params: unknown[] }> {
  return from.flatMap((call) =>
    (call.batch ?? [{ sql: call.sql, params: call.params ?? [] }]).map(
      (statement) => ({
        sql: statement.sql ?? "",
        params: statement.params ?? [],
      }),
    ),
  );
}

function findInsert(table: string) {
  const found = statements().find(({ sql }) =>
    new RegExp(`insert into ${table}\\b`, "i").test(sql),
  );
  expect(found, `an INSERT INTO ${table}`).toBeDefined();
  return found!;
}

/** Decrypts a channel_secrets row the way the deployed Worker would. */
async function decryptSecret(
  ciphertext: string,
  iv: string,
  keyId: string,
): Promise<string> {
  const keyBytes = Buffer.from(SECRETS_KEY, "hex");
  const expectedKeyId = createHash("sha256")
    .update(keyBytes)
    .digest("hex")
    .slice(0, 16);
  expect(keyId).toBe(expectedKeyId);

  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "decrypt",
  ]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv, "base64") },
    key,
    Buffer.from(ciphertext, "base64"),
  );
  return new TextDecoder().decode(plaintext);
}

/** The CLI runs alongside the fake, so the spawn stays async. */
function runCli(
  args: string[],
  input: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("bun", args, {
      cwd: BACKEND,
      env: remoteEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    const killer = setTimeout(() => proc.kill(), 50_000);
    proc.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
    proc.stdin.end(input);
  });
}

describe("account --remote", () => {
  it("creates a platform operator over the HTTP API", async () => {
    const proc = await runCli(
      [
        "src/cli/account.ts",
        "create",
        "ops",
        "--platform-operator",
        "--remote",
      ],
      "a long enough password\n",
    );

    expect(proc.stderr).toBe("");
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("Created platform operator ops");

    const user = findInsert("users");
    expect(user.params[1]).toBe("ops");
    expect(user.params[2]).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(user.params[4]).toBe(1);

    const audit = findInsert("audit_log");
    expect(audit.params[3]).toMatch(/^cli:/);
  });

  it("creates a channel account with its secrets encrypted", async () => {
    const before = calls.length;
    const proc = await runCli(
      [
        "src/cli/account.ts",
        "channel",
        "create",
        "--tenant",
        "totem",
        "--phone-number-id",
        "pn-123",
        "--remote",
      ],
      "meta-access-token\n",
    );

    expect(proc.stderr).toBe("");
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("Created active channel account");

    const secrets = statements(calls.slice(before))
      .filter(({ sql }) => /insert into channel_secrets\b/i.test(sql))
      .map(({ params }) => ({
        purpose: String(params[2]),
        ciphertext: String(params[3]),
        iv: String(params[4]),
        keyId: String(params[5]),
      }));
    expect(secrets.map((secret) => secret.purpose).sort()).toEqual([
      "access_token",
      "verify_token",
    ]);

    const accessToken = secrets.find(
      (secret) => secret.purpose === "access_token",
    )!;
    await expect(
      decryptSecret(accessToken.ciphertext, accessToken.iv, accessToken.keyId),
    ).resolves.toBe("meta-access-token");

    const verifyToken = secrets.find(
      (secret) => secret.purpose === "verify_token",
    )!;
    await expect(
      decryptSecret(verifyToken.ciphertext, verifyToken.iv, verifyToken.keyId),
    ).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);

    const account = findInsert("channel_accounts");
    expect(account.params[1]).toBe(TENANT.id);
    expect(account.params[4]).toBe("pn-123");
    expect(account.params[10]).toBe("active");
  });
});
