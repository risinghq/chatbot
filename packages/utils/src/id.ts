import { v7 } from "uuid";

/**
 * A new primary key. A UUID v7 starts with the time, so later keys sort later
 * and an index grows at its end. The Worker runs on workerd, where
 * `Bun.randomUUIDv7()` does not exist, so the `uuid` package makes it.
 */
export function newId(): string {
  return v7();
}
