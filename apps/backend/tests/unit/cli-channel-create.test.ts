/**
 * `bun run account channel create` stores the generated verify token
 * encrypted, so without SECRETS_KEY the command refuses before it prompts for
 * credentials. This spawns the real CLI, the way an operator runs it.
 *
 * It runs a process, not bindings, so `bun test` runs it and the Workers pool
 * leaves it out.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const BACKEND = join(import.meta.dirname, "..", "..");

describe("account channel create", () => {
  it("refuses to create the account without SECRETS_KEY", () => {
    const proc = spawnSync(
      "bun",
      [
        "src/cli/account.ts",
        "channel",
        "create",
        "--tenant",
        "0196f0a0-0000-7000-8000-000000000001",
        "--phone-number-id",
        "pnid-no-key",
      ],
      {
        cwd: BACKEND,
        env: { ...process.env, SECRETS_KEY: "" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );

    expect(proc.status).toBe(1);
    expect(proc.stderr.toString()).toContain("SECRETS_KEY");
  });
});
