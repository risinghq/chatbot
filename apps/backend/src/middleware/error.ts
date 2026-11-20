import { isProduction } from "../config.ts";
import type { Context } from "hono";
import { InvalidPagingError } from "../lib/http.ts";
import { createLogger } from "../lib/logger.ts";
import { InvalidDateError } from "../db/query.ts";
import { DuplicateSkuError } from "../domains/catalog/variants.ts";
import {
  CustomerHasOrdersError,
  DuplicatePhoneError,
} from "../domains/customers/index.ts";
import {
  DuplicateNameError,
  OrderInputError,
  OrderStateError,
} from "../domains/orders/index.ts";
import { InsufficientStockError } from "../domains/stock/index.ts";
import { TenantScopeRequiredError } from "../platform/auth/scope.ts";
import { NO_ACTIVE_TENANT } from "./auth.ts";

const logger = createLogger("app");

export async function errorHandler(err: Error, c: Context) {
  // A handler asked for the active tenant while none was pinned, so its route
  // is missing `requireActiveTenant`. Refusing it is the point of the invariant.
  // A 500 would hide the missing guard.
  if (err instanceof TenantScopeRequiredError) {
    logger.error(
      { path: c.req.path, method: c.req.method },
      "Route asked for the active tenant without requiring one",
    );
    return c.json(NO_ACTIVE_TENANT, 403);
  }

  if (err instanceof InvalidDateError || err instanceof InvalidPagingError) {
    return c.json({ error: err.message }, 400);
  }

  if (err instanceof OrderInputError) {
    return c.json({ error: err.message }, 400);
  }

  if (
    err instanceof DuplicateSkuError ||
    err instanceof InsufficientStockError ||
    err instanceof OrderStateError ||
    err instanceof DuplicateNameError ||
    err instanceof DuplicatePhoneError ||
    err instanceof CustomerHasOrdersError
  ) {
    return c.json({ error: err.message }, 409);
  }

  logger.error(
    { err, path: c.req.path, method: c.req.method },
    "Unhandled error",
  );

  const isDev = !isProduction();

  return c.json(
    {
      error: "Internal server error",
      message: isDev ? err.message : undefined,
      stack: isDev ? err.stack : undefined,
    },
    500,
  );
}
