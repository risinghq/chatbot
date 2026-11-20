-- How a business's sales assistant talks and sells. One row per business; a
-- business without one uses the defaults in domains/assistant/settings.ts.

CREATE TABLE assistant_settings (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    -- Who the assistant is, how it sells and its tone, in the business's words.
    instructions TEXT NOT NULL DEFAULT '',
    -- Questions customers ask and their answers.
    faq TEXT NOT NULL DEFAULT '',
    -- Delivery times, returns, warranty and the like.
    policies TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    -- Where the assistant's orders hold stock. Null while the business has one
    -- location; with several, an order needs one.
    stock_location_id TEXT REFERENCES stock_locations(id) ON DELETE SET NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
);
