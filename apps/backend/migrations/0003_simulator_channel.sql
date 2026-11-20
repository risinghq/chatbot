-- Each business gets a `simulator` channel, so it can test its assistant
-- before it connects a WhatsApp number. SQLite cannot change a CHECK, so the
-- table is rebuilt.
--
-- Dropping `channel_accounts` deletes every row that cascades from it, and
-- `defer_foreign_keys` does not stop that. The guard aborts the migration
-- while any of those tables holds a row: it ran when they were all empty.
CREATE TABLE simulator_migration_guard (
    cascading_rows INTEGER NOT NULL CHECK(cascading_rows = 0)
);
INSERT INTO simulator_migration_guard
SELECT (SELECT COUNT(*) FROM conversations)
     + (SELECT COUNT(*) FROM unread_alerts)
     + (SELECT COUNT(*) FROM messages)
     + (SELECT COUNT(*) FROM message_inbox)
     + (SELECT COUNT(*) FROM outbox)
     + (SELECT COUNT(*) FROM orders)
     + (SELECT COUNT(*) FROM analytics_events)
     + (SELECT COUNT(*) FROM llm_calls);
DROP TABLE simulator_migration_guard;

PRAGMA defer_foreign_keys = on;

CREATE TABLE channel_accounts_new (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel_type TEXT NOT NULL DEFAULT 'whatsapp' CHECK(channel_type IN ('whatsapp', 'simulator')),
    waba_id TEXT,
    -- A simulator channel holds its tenant's id here, which makes it one per
    -- tenant through the UNIQUE below.
    phone_number_id TEXT NOT NULL,
    display_phone_number TEXT,
    label TEXT,
    access_token_secret_id TEXT REFERENCES channel_secrets(id) ON DELETE SET NULL,
    verify_token_secret_id TEXT REFERENCES channel_secrets(id) ON DELETE SET NULL,
    -- Each number has its own Meta app secret, so numbers on more than one
    -- Meta app can share a deployment.
    app_secret_secret_id TEXT REFERENCES channel_secrets(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('active', 'pending', 'disabled')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE(channel_type, phone_number_id),
    -- Redundant with the primary key. It gives every table that carries both
    -- `tenant_id` and `channel_account_id` a pair to reference, so a row cannot
    -- name tenant A alongside tenant B's number.
    UNIQUE(id, tenant_id)
);

INSERT INTO channel_accounts_new SELECT * FROM channel_accounts;
DROP TABLE channel_accounts;
ALTER TABLE channel_accounts_new RENAME TO channel_accounts;

CREATE INDEX idx_channel_accounts_tenant ON channel_accounts(tenant_id, status);
CREATE INDEX idx_channel_accounts_waba ON channel_accounts(waba_id);
