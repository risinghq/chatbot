-- A TAYPI checkout opened for an order. The id is the reference TAYPI echoes
-- in its webhook, and the pay link's path, so it must not be guessable from
-- an order. A charge lasts as long as its checkout session; an order takes a
-- new one once the last expired.
CREATE TABLE taypi_charges (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    checkout_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'completed', 'expired', 'failed')),
    -- TAYPI's payment id, once the customer paid.
    payment_id TEXT,
    payer_name TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    FOREIGN KEY (order_id, tenant_id)
        REFERENCES orders(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_taypi_charges_order ON taypi_charges(tenant_id, order_id);
