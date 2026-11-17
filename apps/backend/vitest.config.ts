import { createRequire } from "node:module";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, type ViteUserConfig } from "vitest/config";
import { TEST_BINDINGS } from "./tests/bindings.ts";

/**
 * The tests run inside workerd with the bindings in wrangler.jsonc. Each test
 * file gets its own D1, KV and R2 state; `tests/setup.ts` applies the
 * migrations to it. `tests/source` reads files instead of bindings, so Bun
 * runs it.
 *
 * The dashboard tests render Svelte components, so the Svelte compiler runs
 * here too. It is the dashboard's dependency, resolved from that workspace.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const fromFrontend = createRequire(
    path.resolve(import.meta.dirname, "../frontend/package.json"),
  );
  const { svelte } = (await import(
    fromFrontend.resolve("@sveltejs/vite-plugin-svelte")
  )) as { svelte: () => NonNullable<ViteUserConfig["plugins"]>[number] };
  const sveltekitApp = path.resolve(
    import.meta.dirname,
    "tests/helpers/sveltekit-app.ts",
  );

  return {
    plugins: [
      svelte(),
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { ...TEST_BINDINGS, TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    resolve: {
      alias: {
        "$app/env": sveltekitApp,
        "$app/navigation": sveltekitApp,
      },
    },
    test: {
      include: ["tests/**/*.test.ts"],
      exclude: ["tests/source/**"],
      setupFiles: ["./tests/setup.ts"],
      testTimeout: 15_000,
    },
  };
});
