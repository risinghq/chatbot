import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  experimental_readRawConfig,
  getPlatformProxy,
  type Unstable_RawConfig,
} from "wrangler";

type BunRuntime = {
  plugin(plugin: {
    name: string;
    setup(build: {
      module(
        specifier: string,
        load: () => { exports: Record<string, unknown>; loader: "object" },
      ): void;
    }): void;
  }): void;
};

const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../wrangler.jsonc",
);

/**
 * Runs a Bun script against the backend's bindings. Locally that is the D1,
 * KV and R2 state `wrangler dev` uses, under `.wrangler/state`. With `remote`
 * it is the deployed D1 database and R2 bucket, which needs `wrangler login`.
 *
 * The application reads its bindings from `cloudflare:workers`, which only the
 * Workers runtime provides, so a Bun plugin serves that module from the proxy
 * before `load` imports any application code. A script run this way may not
 * call a Durable Object: the proxy does not host the backend's classes, so
 * the script's config leaves them out.
 *
 * Rows written remotely are read by the deployed Worker, so with `remote` the
 * encryption key is the shell's SECRETS_KEY, the deployed one, never the local
 * key in .dev.vars. Without it a command that encrypts refuses.
 */
export async function withPlatform<T>(
  options: { remote: boolean },
  load: () => Promise<T>,
): Promise<T> {
  const config = await scriptConfig(options.remote);
  const proxy = await getPlatformProxy<Env>({
    configPath: config,
    remoteBindings: options.remote,
  });
  const env: Env = options.remote
    ? { ...proxy.env, SECRETS_KEY: process.env.SECRETS_KEY ?? "" }
    : proxy.env;

  const pending: Promise<unknown>[] = [];
  (globalThis as unknown as { Bun: BunRuntime }).Bun.plugin({
    name: "cloudflare-workers",
    setup(build) {
      build.module("cloudflare:workers", () => ({
        exports: {
          env,
          waitUntil: (promise: Promise<unknown>) => pending.push(promise),
          DurableObject: class {},
        },
        loader: "object",
      }));
    },
  });

  try {
    const result = await load();
    await Promise.allSettled(pending);
    return result;
  } finally {
    await proxy.dispose();
    await rm(config, { force: true });
  }
}

/**
 * A copy of wrangler.jsonc without the Durable Objects. With `remote` its D1
 * database and R2 bucket are marked remote, so the proxy reaches the deployed
 * ones.
 *
 * The copy sits next to wrangler.jsonc, because wrangler finds .dev.vars and
 * the local state directory relative to the config it reads.
 */
async function scriptConfig(remote: boolean): Promise<string> {
  const rawConfig: Unstable_RawConfig = experimental_readRawConfig({
    config: CONFIG_PATH,
  }).rawConfig;

  const databases = rawConfig.d1_databases ?? [];
  if (
    remote &&
    databases.some((db) => /^0+(-0+)*$/.test(db.database_id ?? ""))
  ) {
    throw new Error(
      "wrangler.jsonc still holds the placeholder D1 id. Set the real id first (docs/deploy.md).",
    );
  }

  const raw = {
    ...rawConfig,
    $schema: undefined,

    durable_objects: undefined,
    migrations: undefined,
    d1_databases: databases.map((db) => ({ ...db, remote })),
    r2_buckets: (rawConfig.r2_buckets ?? []).map((bucket) => ({
      ...bucket,
      remote,
    })),
  };

  const configPath = path.join(
    path.dirname(CONFIG_PATH),
    `wrangler.script.${process.pid}.json`,
  );
  await writeFile(configPath, JSON.stringify(raw));
  return configPath;
}
