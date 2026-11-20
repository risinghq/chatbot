-- A product's photos, in the order a buyer sees them. The first is the cover.
-- The bytes and their public key belong to the asset row; this table only
-- places an asset on a product.

-- Lets a product image reference the pair, so it cannot place one tenant's
-- asset on another tenant's product.
CREATE UNIQUE INDEX idx_assets_id_tenant ON assets(id, tenant_id);

CREATE TABLE product_images (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE(asset_id),
    FOREIGN KEY (product_id, tenant_id)
        REFERENCES products(id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id, tenant_id)
        REFERENCES assets(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_product_images_product
    ON product_images(tenant_id, product_id, position);
