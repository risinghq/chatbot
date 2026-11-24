/**
 * The built service worker installs the app shell. `$app/manifest`'s
 * `immutable` entries are `{path}` objects without a leading slash; stringified
 * into addAll they become "[object Object]" and install rejects. This loads
 * the built worker in a fake ServiceWorkerGlobalScope and asserts every URL it
 * precaches is a real path.
 */

import { describe, expect, it, beforeAll } from "bun:test";

const swPath = new URL(
  "../.svelte-kit/output/client/service-worker.js",
  import.meta.url,
).pathname;

describe("service worker install", () => {
  beforeAll(async () => {
    if (!(await Bun.file(swPath).exists())) {
      const result = Bun.spawnSync({
        cmd: ["bun", "run", "build"],
        cwd: new URL("..", import.meta.url).pathname,
      });
      if (result.exitCode !== 0) {
        throw new Error(`frontend build failed: ${result.stderr}`);
      }
    }
  });

  it("precaches real shell URLs", async () => {
    const added: unknown[] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const cache = {
      addAll: async (urls: unknown[]) => {
        added.push(...urls);
      },
      match: async () => undefined,
      put: async () => {},
      delete: async () => true,
    };
    const scope = {
      addEventListener: (type: string, listener: (e: unknown) => void) =>
        listeners.set(type, listener),
      skipWaiting: async () => {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      registration: { showNotification: async () => {} },
    };
    Object.assign(globalThis, {
      self: scope,
      caches: {
        open: async () => cache,
        keys: async () => [],
        delete: async () => true,
        match: async () => undefined,
      },
      location: new URL("https://vendeya.test/"),
    });

    await import(`${swPath}?v=${Date.now()}`);

    const installs: Promise<unknown>[] = [];
    listeners.get("install")?.({
      waitUntil: (promise: Promise<unknown>) => installs.push(promise),
    });
    await Promise.all(installs);

    expect(added.length).toBeGreaterThan(0);
    for (const url of added) {
      expect(typeof url).toBe("string");
      expect(
        url === "/" || (url as string).startsWith("/_app/immutable/"),
      ).toBe(true);
    }
  });
});
