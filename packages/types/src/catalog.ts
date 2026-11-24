export type ProductStatus = "draft" | "active" | "archived";

/** What a business sells. Its variants carry the SKU, price and stock. */
export type Product = {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  status: ProductStatus;
  category: string;
  brand: string | null;
  model: string | null;
  specs_json: string | null;
  created_at: number;
  /** Present on list reads. */
  variant_count?: number;
  /** Present on list reads: the first image's public path, or null. */
  cover_url?: string | null;
};

/** A product photo. `position` 0 is the cover. `url` is public. */
export type ProductImage = {
  id: string;
  product_id: string;
  asset_id: string;
  position: number;
  url: string;
  created_at: number;
  /** The variants the photo shows. Empty means the whole product. */
  variant_ids: string[];
};

/** One sellable form of a product. Money is in cents. */
export type ProductVariant = {
  id: string;
  tenant_id: string;
  product_id: string;
  name: string | null;
  sku: string;
  price_cents: number;
  cost_cents: number | null;
  is_active: 0 | 1;
  created_at: number;
};
