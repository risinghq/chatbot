import type { Product } from "@vendeya/types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ cookies, fetch }) => {
  const sessionToken = cookies.get("session");
  if (!sessionToken) return { products: [] };

  try {
    const res = await fetch("/api/catalog/products", {
      headers: { cookie: `session=${sessionToken}` },
    });
    return { products: res.ok ? await res.json<Product[]>() : [] };
  } catch (error) {
    console.error("Error loading catalog:", error);
    return { products: [] };
  }
};
