import { Hono } from "hono";
import { getAllStatus } from "../adapters/providers/health.ts";
import { getOne } from "../db/index.ts";
import { createLogger } from "../lib/logger.ts";

const logger = createLogger("health");

async function databaseUp(): Promise<boolean> {
  try {
    await getOne("SELECT 1 AS up");
    return true;
  } catch (error) {
    logger.error({ error }, "Health check could not reach the database");
    return false;
  }
}

/**
 * Answers 503 when the database does not answer a query. Provider trouble
 * leaves the code at 200 and appears in `status`.
 */
const health = new Hono();

health.get("/", async (c) => {
  const [database, providers] = await Promise.all([
    databaseUp(),
    getAllStatus(),
  ]);
  // FNB blocks are per tenant, so its health is not part of the platform's.
  const healthy =
    database && providers.fnb.available !== false && providers.gaso.available;

  return c.json(
    {
      status: !database ? "unavailable" : healthy ? "healthy" : "degraded",
      database: { status: database ? "healthy" : "unavailable" },
      providers,
      timestamp: new Date().toISOString(),
    },
    database ? 200 : 503,
  );
});

export default health;
