import { env } from "cloudflare:workers";

const requiredEnv = (name: keyof Env): string => {
  const value = env[name];
  if (typeof value !== "string" || !value) {
    throw new Error(`${name} is required but not set`);
  }
  return value;
};

/**
 * The address the outside world reaches the dashboard at, with no trailing
 * slash: CORS compares the origin exactly, and links append a path. The
 * backend's routes share it, so it is also the origin of `/media`.
 */
export function publicOrigin(): string {
  return (env.PUBLIC_URL?.trim() || "http://localhost:5173").replace(
    /\/+$/,
    "",
  );
}

export function isProduction(): boolean {
  return env.ENVIRONMENT === "production";
}

export const config = {
  get calidda() {
    return {
      baseUrl: requiredEnv("CALIDDA_BASE_URL"),
      credentials: {
        username: requiredEnv("CALIDDA_USERNAME"),
        password: requiredEnv("CALIDDA_PASSWORD"),
      },
    };
  },
  get powerbi() {
    return {
      datasetId: requiredEnv("POWERBI_DATASET_ID"),
      reportId: requiredEnv("POWERBI_REPORT_ID"),
      modelId: requiredEnv("POWERBI_MODEL_ID"),
      resourceKey: requiredEnv("POWERBI_RESOURCE_KEY"),
    };
  },
};
