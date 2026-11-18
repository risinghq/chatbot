import process from "node:process";
import type { Unstable_RawConfig } from "wrangler";

/**
 * Bindings for `--remote` scripts, over the Cloudflare HTTP API. D1 goes to
 * `/accounts/<id>/d1/database/<id>/query`, which takes a `batch` of statements
 * inside one transaction the way `env.DB.batch` does. R2 goes to
 * `/accounts/<id>/r2/buckets/<name>/objects/<key>`. Bun's fetch cannot run
 * wrangler's remote bindings (oven-sh/bun#39247), so a script never asks for
 * them.
 */
const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 30_000;

type Api = {
  baseUrl: string;
  accountId: string;
  token: string;
};

type QueryResult = {
  results?: Record<string, unknown>[];
  meta?: Record<string, unknown>;
  success?: boolean;
  error?: string;
};

type ListedObject = {
  key?: string;
  size?: number;
  etag?: string;
  last_modified?: string;
  http_metadata?: Record<string, unknown>;
  custom_metadata?: Record<string, string>;
  storage_class?: string;
};

function cloudflareApi(): Api {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    throw new Error(
      "--remote reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN from " +
        "the environment. Set them first (docs/deploy.md#the-first-accounts).",
    );
  }
  return {
    baseUrl: (process.env.CLOUDFLARE_API_BASE_URL ?? DEFAULT_API_BASE).replace(
      /\/+$/,
      "",
    ),
    accountId,
    token,
  };
}

function request(
  api: Api,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${api.token}`);
  return fetch(`${api.baseUrl}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers,
  });
}

/** A v4 envelope: `{success, errors, result}`. */
async function envelope(
  api: Api,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await request(api, path, init);
  const text = await response.text();

  let body: {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: unknown;
  } | null = null;
  try {
    body = JSON.parse(text);
  } catch {}

  if (!response.ok || body?.success === false) {
    const detail =
      body?.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ") ||
      text ||
      response.statusText;
    throw new Error(
      `Cloudflare API ${init.method ?? "GET"} ${path} failed: ${detail}`,
    );
  }
  return body?.result;
}

/** JSON sends no booleans; SQLite wants the integers it stores. */
function jsonParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

class RemoteStatement {
  constructor(
    private readonly db: RemoteD1,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): D1PreparedStatement {
    return new RemoteStatement(
      this.db,
      this.sql,
      params.map(jsonParam),
    ) as unknown as D1PreparedStatement;
  }

  private execute(): Promise<D1Result> {
    return this.db
      .query({ sql: this.sql, params: this.params })
      .then((results) => results[0]!);
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = (await this.execute()).results?.[0] as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    return (column ? row[column] : row) as T;
  }

  all<T>(): Promise<D1Result<T>> {
    return this.execute() as Promise<D1Result<T>>;
  }

  run<T>(): Promise<D1Result<T>> {
    return this.execute() as Promise<D1Result<T>>;
  }

  async raw<T>(): Promise<T[]> {
    const { results = [] } = await this.execute();
    return (results as Record<string, unknown>[]).map((row) =>
      Object.values(row),
    ) as T[];
  }
}

class RemoteD1 {
  constructor(
    private readonly api: Api,
    private readonly databaseId: string,
  ) {}

  async query(body: {
    sql?: string;
    params?: unknown[];
    batch?: Array<{ sql: string; params: unknown[] }>;
  }): Promise<D1Result[]> {
    const result = (await envelope(
      this.api,
      `/accounts/${this.api.accountId}/d1/database/${this.databaseId}/query`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    )) as QueryResult[];

    return result.map((entry) => {
      if (entry.success === false) {
        throw new Error(`D1 query failed: ${entry.error ?? "unknown error"}`);
      }
      return {
        results: entry.results ?? [],
        success: true,
        meta: entry.meta ?? {},
      } as D1Result;
    });
  }

  prepare(sql: string): D1PreparedStatement {
    return new RemoteStatement(this, sql) as unknown as D1PreparedStatement;
  }

  batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    return this.query({
      batch: (statements as unknown as RemoteStatement[]).map(
        ({ sql, params }) => ({ sql, params }),
      ),
    });
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const results = await this.query({ sql });
    return {
      count: results.length,
      duration: results.reduce(
        (total, result) => total + (result.meta?.duration ?? 0),
        0,
      ),
    } as D1ExecResult;
  }
}

const HTTP_METADATA_HEADERS: Record<string, string> = {
  contentType: "content-type",
  contentLanguage: "content-language",
  contentDisposition: "content-disposition",
  contentEncoding: "content-encoding",
  cacheControl: "cache-control",
};

class RemoteR2 {
  constructor(
    private readonly api: Api,
    private readonly bucketName: string,
  ) {}

  private objectPath(key: string): string {
    const segments = key.split("/").map(encodeURIComponent).join("/");
    return `/accounts/${this.api.accountId}/r2/buckets/${this.bucketName}/objects/${segments}`;
  }

  async put(
    key: string,
    value: unknown,
    options?: { httpMetadata?: Record<string, unknown> },
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    for (const [field, header] of Object.entries(HTTP_METADATA_HEADERS)) {
      const metadata = options?.httpMetadata?.[field];
      if (typeof metadata === "string") headers[header] = metadata;
    }
    const expiry = options?.httpMetadata?.cacheExpiry;
    if (expiry instanceof Date) headers.expires = expiry.toUTCString();

    return await envelope(this.api, this.objectPath(key), {
      method: "PUT",
      headers,
      body: value as BodyInit,
    });
  }

  /** No HEAD exists on the objects API, so a list filtered by prefix answers it. */
  async head(key: string): Promise<unknown> {
    const objects = (await envelope(
      this.api,
      `/accounts/${this.api.accountId}/r2/buckets/${this.bucketName}/objects` +
        `?prefix=${encodeURIComponent(key)}&per_page=1000`,
    )) as ListedObject[];
    const entry = objects.find((object) => object.key === key);
    return entry ? r2Object(entry) : null;
  }

  async get(key: string): Promise<unknown> {
    const response = await request(this.api, this.objectPath(key));
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Cloudflare API GET ${this.objectPath(key)} failed: ${await response.text()}`,
      );
    }

    const httpMetadata: Record<string, unknown> = {};
    for (const [field, header] of Object.entries(HTTP_METADATA_HEADERS)) {
      const value = response.headers.get(header);
      if (value) httpMetadata[field] = value;
    }

    return {
      key,
      body: response.body,
      bodyUsed: false,
      arrayBuffer: () => response.arrayBuffer(),
      text: () => response.text(),
      json: () => response.json(),
      blob: () => response.blob(),
      size: Number(response.headers.get("content-length") ?? 0),
      etag: (response.headers.get("etag") ?? "").replace(/^"|"$/g, ""),
      httpEtag: response.headers.get("etag") ?? "",
      uploaded: new Date(response.headers.get("last-modified") ?? Date.now()),
      httpMetadata,
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of [keys].flat()) {
      await envelope(this.api, this.objectPath(key), { method: "DELETE" });
    }
  }
}

function r2Object(entry: ListedObject): Record<string, unknown> {
  return {
    key: entry.key,
    size: entry.size ?? 0,
    etag: entry.etag ?? "",
    httpEtag: entry.etag ? `"${entry.etag}"` : "",
    uploaded: new Date(entry.last_modified ?? 0),
    httpMetadata: entry.http_metadata ?? {},
    customMetadata: entry.custom_metadata ?? {},
    storageClass: entry.storage_class ?? "Standard",
  };
}

/**
 * The `DB` and `FILES` bindings a remote script gets. Everything else
 * (`KV`, `IMAGES`, the rate limit) stays the local proxy's, as it did when
 * the remote bindings carried only D1 and R2.
 */
export function remoteBindings(rawConfig: Unstable_RawConfig): Partial<Env> {
  const api = cloudflareApi();

  const database = (rawConfig.d1_databases ?? []).find(
    (db) => db.binding === "DB",
  );
  if (!database?.database_id) {
    throw new Error("wrangler.jsonc binds no D1 database named DB.");
  }
  const bucket = (rawConfig.r2_buckets ?? []).find(
    (r2) => r2.binding === "FILES",
  );

  return {
    DB: new RemoteD1(api, database.database_id) as unknown as D1Database,
    ...(bucket?.bucket_name && {
      FILES: new RemoteR2(api, bucket.bucket_name) as unknown as R2Bucket,
    }),
  } as Partial<Env>;
}
