import { env } from "cloudflare:workers";

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const;

type Level = keyof typeof LEVELS;
type Fields = Record<string, unknown>;
type LogFn = (fieldsOrMessage: Fields | string, message?: string) => void;

export type Logger = Record<Level, LogFn>;

const WRITE: Record<Level, (entry: Fields) => void> = {
  debug: (entry) => console.debug(entry),
  info: (entry) => console.log(entry),
  warn: (entry) => console.warn(entry),
  error: (entry) => console.error(entry),
};

const THRESHOLDS: Record<string, number> = {
  ...LEVELS,
  silent: Number.POSITIVE_INFINITY,
};

/**
 * `LOG_LEVEL_<MODULE>` overrides `LOG_LEVEL` for one module. `silent` writes
 * nothing. An unknown level name falls back to `info`.
 */
function thresholdFor(module: string): number {
  const vars = env as unknown as Record<string, unknown>;
  const name = vars[`LOG_LEVEL_${module.toUpperCase()}`] ?? vars.LOG_LEVEL;
  return THRESHOLDS[String(name)] ?? LEVELS.info;
}

/** An Error has no enumerable fields, so it would log as `{}`. */
function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause === undefined ? {} : { cause: serialize(value.cause) }),
    };
  }
  return value;
}

/**
 * One object per entry, passed to `console` unserialized. Workers Logs indexes
 * each field, so a query can filter by `module`, `tenantId` or `level`.
 */
export function createLogger(module: string, context: Fields = {}): Logger {
  const at =
    (level: Level): LogFn =>
    (fieldsOrMessage, message) => {
      if (LEVELS[level] < thresholdFor(module)) return;

      const fields = typeof fieldsOrMessage === "string" ? {} : fieldsOrMessage;
      const entry: Fields = {
        level,
        module,
        message:
          typeof fieldsOrMessage === "string" ? fieldsOrMessage : message,
        ...context,
      };
      for (const [key, value] of Object.entries(fields)) {
        entry[key] = serialize(value);
      }
      WRITE[level](entry);
    };

  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}
