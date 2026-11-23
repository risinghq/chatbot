import type {
  Product,
  ProductImage,
  ProductVariant,
  StockRow,
} from "@vendeya/types";
import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";

export const load: PageServerLoad = async ({ cookies, params, fetch }) => {
  const sessionToken = cookies.get("session");
  if (!sessionToken) {
    throw error(401, "Unauthorized");
  }

  const { id } = params;
  if (id === "new") {
    return { product: null, variants: [], images: [], stock: [] };
  }

  const headers = { cookie: `session=${sessionToken}` };
  const [productRes, variantsRes, imagesRes, stockRes] = await Promise.all([
    fetch(`/api/catalog/products/${id}`, { headers }),
    fetch(`/api/catalog/products/${id}/variants`, { headers }),
    fetch(`/api/catalog/products/${id}/images`, { headers }),
    fetch(`/api/stock?product_id=${encodeURIComponent(id)}`, { headers }),
  ]);

  if (!productRes.ok) {
    throw error(productRes.status, "Product not found");
  }

  const product = await productRes.json<Product>();
  const variants = variantsRes.ok
    ? await variantsRes.json<ProductVariant[]>()
    : [];
  const images = imagesRes.ok ? await imagesRes.json<ProductImage[]>() : [];
  const stock = stockRes.ok ? await stockRes.json<StockRow[]>() : [];
  return { product, variants, images, stock };
};
