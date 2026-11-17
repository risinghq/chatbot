import {
  abortAllDurableObjects,
  applyD1Migrations,
  type D1Migration,
  reset,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { initializeApplication } from "../src/bootstrap/index.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

/** The pool loads the Worker's entry, which wires the same subscribers. */
initializeApplication();

/**
 * Every test starts from an empty schema, empty KV and R2, and no live
 * Durable Object, so no test sees another's rows, breaker state or lock.
 * `reset` runs first: aborting the objects first also aborts the one behind
 * the local D1, and the reset then misses its rows.
 */
beforeEach(async () => {
  await reset();
  await abortAllDurableObjects();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
