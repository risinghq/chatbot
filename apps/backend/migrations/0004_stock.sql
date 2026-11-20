-- A product sells as one or more variants. Each variant has its own SKU, price
-- and stock. Stock changes only through a movement in the ledger; the level is
-- the running sum of its movements, kept in the same batch as each insert.

ALTER TABLE products ADD COLUMN description TEXT;
ALTER TABLE products ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('draft', 'active', 'archived'));

-- Lets a variant reference the pair, so it cannot name one tenant while its
-- product belongs to another.
CREATE UNIQUE INDEX idx_products_id_tenant ON products(id, tenant_id);

CREATE TABLE product_variants (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    -- The option a buyer picks, such as "Rojo / M". Null for a product sold in
    -- one form.
    name TEXT,
    sku TEXT NOT NULL,
    -- Money is in cents of the business's currency, so sums are exact.
    price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
    cost_cents INTEGER CHECK(cost_cents >= 0),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE(tenant_id, sku),
    UNIQUE(id, tenant_id),
    FOREIGN KEY (product_id, tenant_id)
        REFERENCES products(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_variants_product ON product_variants(tenant_id, product_id);

CREATE TABLE stock_locations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE(tenant_id, name),
    UNIQUE(id, tenant_id)
);

-- The CHECKs are the stock rules: a movement that would leave less than zero
-- on hand, or reserve more than is on hand, fails and rolls back its batch.
CREATE TABLE stock_levels (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    on_hand INTEGER NOT NULL DEFAULT 0 CHECK(on_hand >= 0),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0 AND reserved <= on_hand),
    PRIMARY KEY (variant_id, location_id),
    FOREIGN KEY (variant_id, tenant_id)
        REFERENCES product_variants(id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (location_id, tenant_id)
        REFERENCES stock_locations(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_stock_levels_tenant ON stock_levels(tenant_id, location_id);

CREATE TABLE stock_movements (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('receive', 'adjust', 'reserve', 'release', 'ship')),
    -- Positive for every kind but `adjust`, which carries the signed correction.
    quantity INTEGER NOT NULL CHECK(quantity != 0),
    note TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    FOREIGN KEY (variant_id, tenant_id)
        REFERENCES product_variants(id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (location_id, tenant_id)
        REFERENCES stock_locations(id, tenant_id) ON DELETE CASCADE
);

-- v7 ids sort by time, so `id DESC` is newest first.
CREATE INDEX idx_stock_movements_variant ON stock_movements(tenant_id, variant_id, id DESC);
CREATE INDEX idx_stock_movements_tenant ON stock_movements(tenant_id, id DESC);
