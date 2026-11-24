-- A business that sells on Shopify connects its store: the catalog follows
-- Shopify, and a confirmed VendeYa order is written back as a Shopify order.

-- The non-secret half of the connection. The Admin API token and the webhook
-- signing secret live in tenant_secrets, encrypted like the other keys.
CREATE TABLE shopify_connections (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    shop_domain TEXT NOT NULL,
    last_synced_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
);

-- The ids a sync keys on: re-importing updates the same rows instead of
-- duplicating them. Null for catalog a person entered by hand.
ALTER TABLE products ADD COLUMN shopify_product_id TEXT;
ALTER TABLE product_variants ADD COLUMN shopify_variant_id TEXT;
ALTER TABLE product_variants ADD COLUMN shopify_inventory_item_id TEXT;
ALTER TABLE product_images ADD COLUMN shopify_image_id TEXT;

CREATE UNIQUE INDEX idx_products_shopify_id
    ON products(tenant_id, shopify_product_id);
CREATE UNIQUE INDEX idx_variants_shopify_id
    ON product_variants(tenant_id, shopify_variant_id);
CREATE INDEX idx_variants_shopify_item
    ON product_variants(tenant_id, shopify_inventory_item_id);
CREATE INDEX idx_product_images_shopify_id
    ON product_images(tenant_id, shopify_image_id);

-- The Shopify order id a confirmed order was written back as.
ALTER TABLE orders ADD COLUMN shopify_order_id TEXT;

-- The write-back queue. An order confirm files one row when the business is
-- connected and a line is an imported variant; the sweep sends what is due
-- and a failure waits with its error until the next attempt.
CREATE TABLE shopify_order_syncs (
    tenant_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'sending', 'synced', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    PRIMARY KEY (tenant_id, order_id),
    FOREIGN KEY (order_id, tenant_id)
        REFERENCES orders(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_shopify_syncs_due
    ON shopify_order_syncs(status, next_attempt_at);
