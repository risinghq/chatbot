import { env } from "cloudflare:workers";
import { vi } from "vitest";

/**
 * The entries the loggers wrote at `level` or above while `run` ran. Each
 * logger writes one object per entry to the console method of its level, and
 * the tests' `LOG_LEVEL` is `silent` outside this.
 */
export async function logsDuring(
  level: "warn" | "error",
  run: () => Promise<unknown>,
): Promise<Array<Record<string, any>>> {
  const saved = env.LOG_LEVEL;
  env.LOG_LEVEL = level;
  const entries: Array<Record<string, any>> = [];
  const capture = (entry: unknown) => {
    if (entry && typeof entry === "object") {
      entries.push(entry as Record<string, any>);
    }
  };
  const spies = [
    vi.spyOn(console, "error").mockImplementation(capture),
    ...(level === "warn"
      ? [vi.spyOn(console, "warn").mockImplementation(capture)]
      : []),
  ];
  try {
    await run();
  } finally {
    env.LOG_LEVEL = saved;
    for (const spy of spies) spy.mockRestore();
  }
  return entries;
}
