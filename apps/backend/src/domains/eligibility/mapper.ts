import { BundleService } from "../catalog/index.ts";
import { getCategoryDisplayNames } from "../../adapters/catalog/display.ts";
import { CATEGORIES, CATEGORY_GROUPS } from "@vendeya/types";
import type {
  Bundle,
  CategoryGroup,
  CategoryKey,
  ProviderCheckResult,
  Segment,
} from "@vendeya/types";

type EligibilityResult = ProviderCheckResult & {
  needsHuman?: boolean;
  handoffReason?: string;
  name?: string;
  nse?: number;
};

export type EligibilityOutcome = {
  type: "eligibility_result";
  status: "eligible" | "not_eligible" | "needs_human" | "system_outage";
  segment?: Segment;
  credit?: number;
  name?: string;
  nse?: number;
  requiresAge?: boolean;
  handoffReason?: string;
  affordableCategories?: string[];
  affordableBundles?: Bundle[];
  categoryDisplayNames?: string[];
  groupDisplayNames?: string[];
  /**
   * Set on `eligible` only. False means no tenant owned the check, so the
   * affordable* fields are absent because no catalog was consulted.
   */
  catalogChecked?: boolean;
};

export async function mapEligibilityToEnrichment(
  tenantId: string | null,
  result: EligibilityResult,
): Promise<EligibilityOutcome> {
  if (result.needsHuman) {
    if (result.handoffReason === "both_providers_down") {
      return {
        type: "eligibility_result",
        status: "system_outage",
        handoffReason: result.handoffReason,
      };
    }
    return {
      type: "eligibility_result",
      status: "needs_human",
      handoffReason: result.handoffReason,
    };
  }

  if (result.eligible) {
    const segment = result.nse !== undefined ? "gaso" : "fnb";
    const credit = result.credit || 0;

    // A null `tenantId` means nothing owns the check. GET /api/providers/:dni
    // checks a DNI for no tenant, so there is no business catalog to consult.
    // An empty string would match no tenant in `WHERE b.tenant_id = ?`
    // and read as an empty catalog. `catalogChecked: false` says the catalog was
    // skipped, so an empty list never implies an answer nobody computed.
    if (tenantId === null) {
      return {
        type: "eligibility_result",
        status: "eligible",
        segment,
        credit,
        name: result.name,
        nse: result.nse,
        requiresAge: segment === "gaso",
        catalogChecked: false,
      };
    }

    const affordableCategories = await BundleService.getAffordableCategories(
      tenantId,
      segment,
      credit,
    );

    const groups = new Set<CategoryGroup>();
    for (const categoryKey of affordableCategories) {
      const category = CATEGORIES[categoryKey as CategoryKey];
      if (category?.group) groups.add(category.group);
    }

    const groupDisplayNames: string[] = [];
    for (const groupKey of groups) {
      const display = CATEGORY_GROUPS[groupKey]?.display;
      if (display) {
        groupDisplayNames.push(display);
      }
    }

    groupDisplayNames.sort((a, b) => {
      const order: Record<string, number> = {
        "línea blanca y hogar": 0,
        tecnología: 1,
        combos: 2,
      };
      const aKey = a.toLowerCase();
      const bKey = b.toLowerCase();
      return (order[aKey] ?? 99) - (order[bKey] ?? 99);
    });

    const affordableBundles = await BundleService.getAvailable(tenantId, {
      segment,
      maxPrice: credit,
      strictPriceLimit: segment === "gaso", // gaso is strict, fnb is soft
    });

    return {
      type: "eligibility_result",
      status: "eligible",
      segment,
      credit,
      name: result.name,
      nse: result.nse,
      requiresAge: segment === "gaso",
      affordableCategories,
      categoryDisplayNames: getCategoryDisplayNames(affordableCategories),
      groupDisplayNames,
      affordableBundles,
      catalogChecked: true,
    };
  }

  return {
    type: "eligibility_result",
    status: "not_eligible",
  };
}
