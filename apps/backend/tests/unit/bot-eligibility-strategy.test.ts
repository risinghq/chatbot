import { describe, expect, test } from "vitest";
import type { ProviderCheckResult } from "@vendeya/types";

import { evaluateResults } from "../../src/domains/eligibility/strategy/eligibility-strategy.ts";
import { ProviderError } from "../../src/domains/eligibility/providers/provider.ts";
import { Err, Ok } from "../../src/shared/result/index.ts";

const fnbApproved: ProviderCheckResult = {
  eligible: true,
  credit: 3000,
  name: "Ana",
};
const gasoApproved: ProviderCheckResult = {
  eligible: true,
  credit: 2500,
  name: "Ana",
  nse: 3,
};
const refused: ProviderCheckResult = {
  eligible: false,
  credit: 0,
  reason: "not_qualified",
};
const down = (provider: string) =>
  Err(new ProviderError(provider, "unavailable", "timeout"));

describe("evaluateResults", () => {
  test("FNB approval wins over a Power BI approval", async () => {
    const r = evaluateResults({
      fnb: Ok(fnbApproved),
      powerbi: Ok(gasoApproved),
    });
    if (!r.ok) throw r.error;
    expect(r.value.source).toBe("fnb");
    expect(r.value.result).toEqual(fnbApproved);
  });

  test("Power BI approval wins over an FNB refusal", async () => {
    const r = evaluateResults({ fnb: Ok(refused), powerbi: Ok(gasoApproved) });
    if (!r.ok) throw r.error;
    expect(r.value.source).toBe("powerbi");
    expect(r.value.result).toEqual(gasoApproved);
    expect(r.value.warnings).toBeUndefined();
  });

  test("both refuse: not eligible", async () => {
    const r = evaluateResults({ fnb: Ok(refused), powerbi: Ok(refused) });
    if (!r.ok) throw r.error;
    expect(r.value.result.eligible).toBe(false);
    expect(r.value.warnings).toBeUndefined();
  });

  test("FNB down, Power BI approves: Power BI with a warning", async () => {
    const r = evaluateResults({ fnb: down("FNB"), powerbi: Ok(gasoApproved) });
    if (!r.ok) throw r.error;
    expect(r.value.source).toBe("powerbi");
    expect(r.value.result.eligible).toBe(true);
    expect(r.value.warnings?.[0]?.failedProvider).toBe("FNB");
  });

  test("Power BI down, FNB approves: FNB with a warning", async () => {
    const r = evaluateResults({
      fnb: Ok(fnbApproved),
      powerbi: down("PowerBI"),
    });
    if (!r.ok) throw r.error;
    expect(r.value.source).toBe("fnb");
    expect(r.value.warnings?.[0]?.failedProvider).toBe("PowerBI");
  });

  test("one down, the other refuses: not eligible, not an outage", async () => {
    for (const results of [
      { fnb: down("FNB"), powerbi: Ok(refused) },
      { fnb: Ok(refused), powerbi: down("PowerBI") },
    ]) {
      const r = evaluateResults(results);
      if (!r.ok) throw r.error;
      expect(r.value.result.eligible).toBe(false);
      expect(r.value.warnings).toHaveLength(1);
    }
  });

  test("a provider that answers with a technical failure counts as down", async () => {
    const r = evaluateResults({
      fnb: Ok({ eligible: false, credit: 0, reason: "api_error" }),
      powerbi: Ok(gasoApproved),
    });
    if (!r.ok) throw r.error;
    expect(r.value.source).toBe("powerbi");
    expect(r.value.warnings?.[0]?.failedProvider).toBe("FNB");
  });

  test("both down: system outage", async () => {
    const r = evaluateResults({ fnb: down("FNB"), powerbi: down("PowerBI") });
    expect(r.ok).toBe(false);
  });
});
