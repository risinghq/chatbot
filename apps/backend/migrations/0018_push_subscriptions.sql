-- Web Push subscriptions. A user opts in per business on the dashboard's
-- Cuenta page, so a row belongs to (tenant, user). The push service's endpoint
-- is the subscription's identity: opting in again replaces the row, and a send
-- the service answers 404 or 410 deletes it.

CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE (tenant_id, endpoint)
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(tenant_id, user_id);
