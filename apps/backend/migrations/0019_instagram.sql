-- Instagram professional accounts join WhatsApp numbers as channels. SQLite
-- cannot change a CHECK, so `channel_accounts` is rebuilt.
--
-- Dropping `channel_accounts` deletes every row that cascades from it, and
-- `orders` refuses the drop while it holds a row. The migration runs on an
-- empty database.

PRAGMA defer_foreign_keys = on;

CREATE TABLE channel_accounts_new (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel_type TEXT NOT NULL DEFAULT 'whatsapp'
        CHECK(channel_type IN ('whatsapp', 'instagram', 'simulator')),
    waba_id TEXT,
    -- WhatsApp: the phone number id. Instagram: the professional account id
    -- that webhooks carry as `entry[].id`. Simulator: its tenant's id, which
    -- makes it one per tenant through the UNIQUE below.
    phone_number_id TEXT NOT NULL,
    -- WhatsApp: the number as people dial it. Instagram: the @username.
    display_phone_number TEXT,
    label TEXT,
    access_token_secret_id TEXT REFERENCES channel_secrets(id) ON DELETE SET NULL,
    verify_token_secret_id TEXT REFERENCES channel_secrets(id) ON DELETE SET NULL,
    -- Each account has its own Meta app secret, so accounts on more than one
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

-- One row per Instagram comment the shop's auto-reply handled. The primary
-- key is the claim: Meta allows one private reply per comment, and a
-- redelivered webhook must not send a second.
CREATE TABLE instagram_comments (
    comment_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel_account_id TEXT NOT NULL,
    media_id TEXT,
    -- The commenter's Instagram-scoped id; their DM conversation uses it.
    from_id TEXT NOT NULL,
    from_username TEXT,
    text TEXT NOT NULL,
    public_reply_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(public_reply_status IN ('pending', 'sent', 'failed', 'skipped')),
    private_reply_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(private_reply_status IN ('pending', 'sent', 'failed', 'skipped')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    FOREIGN KEY (channel_account_id, tenant_id)
        REFERENCES channel_accounts(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_instagram_comments_tenant ON instagram_comments(tenant_id, created_at);
