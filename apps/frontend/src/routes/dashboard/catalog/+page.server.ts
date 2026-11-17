import type { Bundle, CatalogPeriod, Product, Segment } from "@vendeya/types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ cookies, url, fetch }) => {
  const sessionToken = cookies.get("session");
  if (!sessionToken) {
    return {
      baseProducts: [],
      bundles: [],
      fnbOfferings: [],
      periods: [],
      activePeriod: null,
    };
  }

  const headers = { cookie: `session=${sessionToken}` };

  try {
    const periodsRes = await fetch("/api/periods", { headers });
    const periods = periodsRes.ok
      ? await periodsRes.json<CatalogPeriod[]>()
      : [];

    const selectedPeriodId = url.searchParams.get("period");
    let activePeriod =
      periods.find((p) => p.status === "active") || periods[0] || null;

    if (selectedPeriodId) {
      const selected = periods.find((p) => p.id === selectedPeriodId);
      if (selected) activePeriod = selected;
    }

    const bundlesFor = async (segment: Segment): Promise<Bundle[]> => {
      if (!activePeriod) return [];
      const res = await fetch(
        `/api/catalog/bundles?period_id=${activePeriod.id}&segment=${segment}`,
        { headers },
      );
      return res.ok ? res.json<Bundle[]>() : [];
    };

    const [productsRes, bundles, fnbOfferings] = await Promise.all([
      fetch("/api/catalog/products", { headers }),
      bundlesFor("gaso"),
      bundlesFor("fnb"),
    ]);

    const baseProducts = productsRes.ok
      ? await productsRes.json<Product[]>()
      : [];

    return { baseProducts, bundles, fnbOfferings, periods, activePeriod };
  } catch (error) {
    console.error("Error loading catalog:", error);
    return {
      baseProducts: [],
      bundles: [],
      fnbOfferings: [],
      periods: [],
      activePeriod: null,
    };
  }
};
