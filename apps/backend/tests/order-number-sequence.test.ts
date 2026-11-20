import { beforeEach, describe, expect, it } from "vitest";

import { FIRST_ORDER_NUMBER } from "../src/domains/orders/index.ts";
import {
  createTenantFixture,
  fileOrder,
  type TenantFixture,
} from "./helpers/tenancy.ts";

describe("order number sequence", () => {
  let firstTenant: TenantFixture;
  let secondTenant: TenantFixture;

  beforeEach(async () => {
    firstTenant = await createTenantFixture("order-sequence-first");
    secondTenant = await createTenantFixture("order-sequence-second");
  });

  /**
   * Orders created at once each take the next number and none repeats. The
   * number is read by the insert itself, so no two batches see the same
   * highest number.
   */
  it("numbers concurrent orders without a repeat", async () => {
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fileOrder(firstTenant.ref(`5190000000${index}`)),
      ),
    );

    expect(created.map((order) => order.number).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => FIRST_ORDER_NUMBER + index),
    );
  });

  it("starts each business at the first number", async () => {
    await fileOrder(firstTenant.ref("51900000001"));
    await fileOrder(firstTenant.ref("51900000001"));

    const order = await fileOrder(secondTenant.ref("51900000002"));
    expect(order.number).toBe(FIRST_ORDER_NUMBER);
  });
});
