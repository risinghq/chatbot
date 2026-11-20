import type { Product, ProductVariant } from "@vendeya/types";
import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";

export const load: PageServerLoad = async ({ cookies, params, fetch }) => {
  const sessionToken = cookies.get("session");
  if (!sessionToken) {
    throw error(401, "Unauthorized");
  }

  const { id } = params;
  if (id === "new") {
    return { product: null, variants: [] };
  }

  const headers = { cookie: `session=${sessionToken}` };
  const [productRes, variantsRes] = await Promise.all([
    fetch(`/api/catalog/products/${id}`, { headers }),
    fetch(`/api/catalog/products/${id}/variants`, { headers }),
  ]);

  if (!productRes.ok) {
    throw error(productRes.status, "Product not found");
  }

  const product = await productRes.json<Product>();
  const variants = variantsRes.ok
    ? await variantsRes.json<ProductVariant[]>()
    : [];
  return { product, variants };
};
