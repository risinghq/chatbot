import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_URL = "https://sales.rising.sh";

export type Credentials = { url: string; token: string };

/** Where `vendeya login` keeps the token, readable by its owner only. */
export function credentialsPath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "vendeya", "credentials.json");
}

/**
 * The server and token a command uses. VENDEYA_TOKEN and VENDEYA_URL win over
 * the stored file, so one shell can point at another server or account
 * without logging out.
 */
export async function resolveCredentials(
  env: NodeJS.ProcessEnv,
): Promise<Credentials | null> {
  const stored = await readStored(env);
  const token = env.VENDEYA_TOKEN || stored?.token;
  if (!token) return null;
  const url = env.VENDEYA_URL || stored?.url || DEFAULT_URL;
  return { url: url.replace(/\/+$/, ""), token };
}

async function readStored(env: NodeJS.ProcessEnv): Promise<Credentials | null> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(env), "utf8"));
    return typeof parsed?.token === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function storeCredentials(
  env: NodeJS.ProcessEnv,
  credentials: Credentials,
): Promise<string> {
  const file = credentialsPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created; an older file keeps its own.
  await chmod(file, 0o600);
  return file;
}

export async function forgetCredentials(env: NodeJS.ProcessEnv): Promise<void> {
  await rm(credentialsPath(env), { force: true });
}
