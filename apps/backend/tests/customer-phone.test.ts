/** A customer's phone is stored the way WhatsApp sends it, so it finds their conversation. */

import { describe, it, expect } from "vitest";

import {
  normalizePhone,
  parseCustomerFields,
} from "../src/domains/customers/index.ts";

describe("a customer's phone", () => {
  it("gains Peru's country code when typed as a nine-digit mobile", () => {
    expect(normalizePhone("987 654 321")).toBe("51987654321");
    expect(normalizePhone("987-654-321")).toBe("51987654321");
  });

  it("keeps a number that already carries a country code", () => {
    expect(normalizePhone("+51 987 654 321")).toBe("51987654321");
    expect(normalizePhone("+1 (415) 555-0100")).toBe("14155550100");
  });

  it("leaves a number that is not a Peruvian mobile as typed", () => {
    expect(normalizePhone("01 4567890")).toBe("014567890");
    expect(normalizePhone("  ")).toBeNull();
  });

  it("is stored with the code when the owner saves the customer", () => {
    expect(
      parseCustomerFields({ name: "Carlos", phone: "987654321" }, false),
    ).toMatchObject({
      phone: "51987654321",
    });
  });
});
