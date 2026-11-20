-- Customers, orders, payments and shipments for any shop. The table this
-- replaces held the Cálidda approval flow; production had no real order in it.

DROP TABLE orders;

CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- Digits with the country code, as WhatsApp sends it. Null for a customer
    -- staff entered without one.
    phone TEXT,
    email TEXT,
    document_type TEXT CHECK(document_type IN ('dni', 'ce', 'ruc', 'passport')),
    document_number TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    CHECK((document_type IS NULL) = (document_number IS NULL)),
    UNIQUE(id, tenant_id)
);

CREATE UNIQUE INDEX idx_customers_phone ON customers(tenant_id, phone)
    WHERE phone IS NOT NULL;
CREATE INDEX idx_customers_tenant ON customers(tenant_id, id DESC);

CREATE TABLE customer_addresses (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL,
    line TEXT NOT NULL,
    district TEXT,
    city TEXT,
    reference TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    FOREIGN KEY (customer_id, tenant_id)
        REFERENCES customers(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_customer_addresses ON customer_addresses(tenant_id, customer_id);

CREATE TABLE delivery_zones (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    fee_cents INTEGER NOT NULL CHECK(fee_cents >= 0),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE(tenant_id, name),
    UNIQUE(id, tenant_id)
);

CREATE TABLE payment_methods (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- What the customer is told to do, such as an account number to transfer to.
    instructions TEXT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE(tenant_id, name),
    UNIQUE(id, tenant_id)
);

-- Payment is not a status: cash on delivery is paid after delivery and a
-- transfer before packing. The payment state is derived from `payments`.
CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- What people call the order. Per business, from 1001.
    number INTEGER NOT NULL,
    -- No ON DELETE: a customer with orders cannot be deleted, so an order keeps its buyer.
    customer_id TEXT NOT NULL,
    -- The number the sale came through. Null for an order staff entered.
    channel_account_id TEXT,
    source TEXT NOT NULL CHECK(source IN ('assistant', 'staff')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled')),
    -- Where reserved units are held. Null when no line is a stocked variant.
    location_id TEXT,
    subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents >= 0),
    delivery_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK(delivery_fee_cents >= 0),
    total_cents INTEGER NOT NULL CHECK(total_cents = subtotal_cents + delivery_fee_cents),
    notes TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE(tenant_id, number),
    UNIQUE(id, tenant_id),
    FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id),
    FOREIGN KEY (channel_account_id, tenant_id) REFERENCES channel_accounts(id, tenant_id),
    FOREIGN KEY (location_id, tenant_id) REFERENCES stock_locations(id, tenant_id)
);

CREATE INDEX idx_orders_status ON orders(tenant_id, status, id DESC);
CREATE INDEX idx_orders_customer ON orders(tenant_id, customer_id);
CREATE INDEX idx_orders_created_by ON orders(tenant_id, created_by);

-- A line copies the name, SKU and price at the time of sale, so a later price
-- change does not rewrite an old order.
CREATE TABLE order_lines (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    -- Null for a line that is not a stocked variant, such as a Cálidda bundle.
    variant_id TEXT,
    sku TEXT,
    name TEXT NOT NULL,
    unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    position INTEGER NOT NULL,
    FOREIGN KEY (order_id, tenant_id)
        REFERENCES orders(id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id, tenant_id)
        REFERENCES product_variants(id, tenant_id)
);

CREATE INDEX idx_order_lines_order ON order_lines(tenant_id, order_id, position);

CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    payment_method_id TEXT REFERENCES payment_methods(id) ON DELETE SET NULL,
    -- The method's name when it was recorded, kept if the method is renamed.
    method_name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'confirmed', 'rejected')),
    -- The bank operation number or similar, to match it with the statement.
    reference TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    decided_at INTEGER,
    FOREIGN KEY (order_id, tenant_id)
        REFERENCES orders(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_payments_order ON payments(tenant_id, order_id);

-- At most one per order. An order without one is picked up.
CREATE TABLE shipments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    delivery_zone_id TEXT REFERENCES delivery_zones(id) ON DELETE SET NULL,
    zone_name TEXT,
    recipient_name TEXT NOT NULL,
    recipient_phone TEXT,
    address_line TEXT NOT NULL,
    district TEXT,
    city TEXT,
    reference TEXT,
    carrier TEXT,
    tracking_code TEXT,
    shipped_at INTEGER,
    delivered_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE(order_id),
    FOREIGN KEY (order_id, tenant_id)
        REFERENCES orders(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_shipments_tenant ON shipments(tenant_id, id DESC);

-- The order a reserve, release or ship belongs to. Null for receive and adjust.
ALTER TABLE stock_movements ADD COLUMN order_id TEXT REFERENCES orders(id) ON DELETE SET NULL;
