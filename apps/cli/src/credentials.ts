import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_URL = "https://sales.rising.sh";

/** `business` is the one every request names, set by `businesses use`. */
export type Credentials = { url: string; token: string; business?: string };

type Stored = Partial<Credentials>;

/** Where `vendeya login` keeps the token, readable by its owner only. */
export function credentialsPath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "vendeya", "credentials.json");
}

/**
 * The server, token and business a command uses. VENDEYA_TOKEN, VENDEYA_URL
 * and VENDEYA_BUSINESS win over the stored file, so one shell can point at
 * another server, account or business without logging out.
 */
export async function resolveCredentials(
  env: NodeJS.ProcessEnv,
): Promise<Credentials | null> {
  const stored = await readStored(env);
  const token = env.VENDEYA_TOKEN || stored.token;
  if (!token) return null;
  const url = env.VENDEYA_URL || stored.url || DEFAULT_URL;
  const business = env.VENDEYA_BUSINESS || stored.business;
  return { url: url.replace(/\/+$/, ""), token, ...(business && { business }) };
}

async function readStored(env: NodeJS.ProcessEnv): Promise<Stored> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(env), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeStored(
  env: NodeJS.ProcessEnv,
  stored: Stored,
): Promise<string> {
  const file = credentialsPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created; an older file keeps its own.
  await chmod(file, 0o600);
  return file;
}

/** A new login starts in no business. */
export function storeCredentials(
  env: NodeJS.ProcessEnv,
  credentials: Credentials,
): Promise<string> {
  return writeStored(env, { url: credentials.url, token: credentials.token });
}

/** Keeps the login and names `business` on every later request, or none. */
export async function storeBusiness(
  env: NodeJS.ProcessEnv,
  business: string | null,
): Promise<string> {
  const { business: _previous, ...rest } = await readStored(env);
  return writeStored(env, business ? { ...rest, business } : rest);
}

export async function forgetCredentials(env: NodeJS.ProcessEnv): Promise<void> {
  await rm(credentialsPath(env), { force: true });
}
