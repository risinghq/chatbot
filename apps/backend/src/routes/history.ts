import { Hono } from "hono";
import { businessHistory } from "../domains/history/index.ts";
import { queryLimit, queryOffset } from "../lib/http.ts";
import {
  activeTenantId,
  requireRole,
  requireTenantScope,
} from "../middleware/auth.ts";

/** What the business's team and terminal commands changed, newest first. */
const history = new Hono();

history.use("/*", requireTenantScope);
// It names who did what to whom, which a sales agent's work does not need.
history.use("/*", requireRole("admin", "developer", "supervisor"));

history.get("/", async (c) => {
  const page = { limit: queryLimit(c, 50), offset: queryOffset(c) };
  return c.json({
    entries: await businessHistory(activeTenantId(c), page),
  });
});

export default history;
