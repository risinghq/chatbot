/** The rows `getOne` gives back, and the Lima calendar-day helpers the report and funnel ranges are cut with. */

import { describe, expect, it } from "vitest";

import { getOne } from "../src/db/index.ts";
import {
  InvalidDateError,
  limaDateString,
  limaDayBounds,
  limaRangeEdge,
} from "../src/db/query.ts";

describe("getOne", () => {
  it("gives undefined, not null, when no row matches", async () => {
    const missing = await getOne("SELECT 1 AS one WHERE 0");

    expect(missing).toBeUndefined();
    expect(missing === null).toBe(false);
  });

  it("gives the row when one matches", async () => {
    expect(await getOne<{ one: number }>("SELECT 1 AS one")).toEqual({
      one: 1,
    });
  });
});

describe("the Lima day", () => {
  describe("on a Worker, whose clock is UTC", () => {
    it("runs from Lima midnight to the last millisecond before the next", async () => {
      expect(limaDayBounds("2026-09-19")).toEqual([
        Date.parse("2026-09-19T05:00:00.000Z"),
        Date.parse("2026-09-20T04:59:59.999Z"),
      ]);
    });

    it("is the Lima day containing now when no date is given", async () => {
      const late = Date.parse("2026-09-20T03:00:00.000Z");

      expect(limaDayBounds(undefined, late)).toEqual([
        Date.parse("2026-09-19T05:00:00.000Z"),
        Date.parse("2026-09-20T04:59:59.999Z"),
      ]);
    });

    it("rolls over at Lima midnight, not UTC midnight", async () => {
      const justBefore = Date.parse("2026-09-19T04:59:59.999Z");
      const atMidnight = Date.parse("2026-09-19T05:00:00.000Z");

      expect(limaDayBounds(undefined, justBefore)[0]).toBe(
        Date.parse("2026-09-18T05:00:00.000Z"),
      );
      expect(limaDayBounds(undefined, atMidnight)[0]).toBe(atMidnight);
    });
  });

  describe("a date that is not a calendar day", () => {
    it.each([
      "garbage",
      "",
      "2026-13-01",
      "2026-02-30",
      "2027-02-29",
      "2026-9-1",
      "0050-01-01",
      "2026-09-19T10:00:00Z",
    ])("is refused: %p", async (value) => {
      expect(() => limaDayBounds(value)).toThrow(InvalidDateError);
    });

    it("accepts a leap day", async () => {
      expect(limaDayBounds("2028-02-29")[0]).toBe(
        Date.parse("2028-02-29T05:00:00.000Z"),
      );
    });

    it("names the field and the accepted form", async () => {
      expect(() => limaDayBounds("garbage")).toThrow("date must be YYYY-MM-DD");
    });
  });

  describe("naming a day", () => {
    it("reads the Lima date, not the UTC one", async () => {
      expect(limaDateString(Date.parse("2026-09-20T04:59:59.999Z"))).toBe(
        "2026-09-19",
      );
      expect(limaDateString(Date.parse("2026-09-20T05:00:00.000Z"))).toBe(
        "2026-09-20",
      );
    });
  });

  describe("one end of a range", () => {
    it("opens a date-only start at Lima midnight", async () => {
      expect(limaRangeEdge("2026-03-10", "start", "start")).toBe(
        Date.parse("2026-03-10T05:00:00.000Z"),
      );
    });

    it("closes a date-only end on the last millisecond of that Lima day", async () => {
      expect(limaRangeEdge("2026-03-10", "end", "end")).toBe(
        Date.parse("2026-03-11T04:59:59.999Z"),
      );
    });

    it.each([
      ["2026-03-10T12:30:00.000Z", "2026-03-10T12:30:00.000Z"],
      ["2026-03-10T12:30:00Z", "2026-03-10T12:30:00.000Z"],
      ["2026-03-10T07:30:00-05:00", "2026-03-10T12:30:00.000Z"],
      ["2026-03-10T21:30+09:00", "2026-03-10T12:30:00.000Z"],
      ["2028-02-29T12:00:00Z", "2028-02-29T12:00:00.000Z"],
    ])("keeps the exact instant of %s", async (value, instant) => {
      expect(limaRangeEdge(value, "start", "start")).toBe(Date.parse(instant));
      expect(limaRangeEdge(value, "end", "end")).toBe(Date.parse(instant));
    });

    it.each([
      "garbage",
      "2026-13-01",
      "2026-02-30",
      "2026-03-10T12:30:00",
      "2026-03-10T25:00:00Z",
      "2026-02-30T12:00:00Z",
      "2026-02-29T12:00:00Z",
      "2026-04-31T00:00:00-05:00",
      "2026-06-31T23:59:59Z",
      "March 10, 2026",
      "1789847378581",
    ])("refuses %p, and says which field", async (value) => {
      expect(() => limaRangeEdge(value, "start", "startDate")).toThrow(
        /^startDate must be YYYY-MM-DD or an ISO timestamp with a zone$/,
      );
    });
  });
});
