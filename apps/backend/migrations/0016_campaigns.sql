-- Campaigns and reminders send WhatsApp message templates, which Meta requires
-- outside the 24-hour window. `messages` and `outbox` gain the 'template' type,
-- which SQLite cannot add to a CHECK, so both tables are rebuilt.

PRAGMA defer_foreign_keys = on;

CREATE TABLE messages_new (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel_account_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
    type TEXT NOT NULL CHECK(type IN ('text', 'image', 'template')),
    content TEXT,
    whatsapp_message_id TEXT,
    product_id TEXT,
    status TEXT DEFAULT 'sent',
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    FOREIGN KEY (channel_account_id, tenant_id)
        REFERENCES channel_accounts(id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, channel_account_id, phone_number)
        REFERENCES conversations(tenant_id, channel_account_id, phone_number) ON DELETE CASCADE
);

INSERT INTO messages_new SELECT * FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

CREATE INDEX idx_messages_phone ON messages(tenant_id, channel_account_id, phone_number, created_at DESC);
CREATE INDEX idx_messages_whatsapp_id ON messages(whatsapp_message_id);

CREATE TABLE outbox_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel_account_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    message_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('text', 'image', 'template')),
    content TEXT NOT NULL,
    caption TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    ambiguous_attempts INTEGER NOT NULL DEFAULT 0,
    last_kind TEXT,
    last_reason TEXT,
    next_attempt_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    handed_off_at INTEGER,
    FOREIGN KEY (channel_account_id, tenant_id)
        REFERENCES channel_accounts(id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, channel_account_id, phone_number)
        REFERENCES conversations(tenant_id, channel_account_id, phone_number) ON DELETE CASCADE
);

INSERT INTO outbox_new SELECT * FROM outbox;
DROP TABLE outbox;
ALTER TABLE outbox_new RENAME TO outbox;

CREATE INDEX idx_outbox_due ON outbox(status, next_attempt_at);
CREATE INDEX idx_outbox_conversation ON outbox(tenant_id, channel_account_id, phone_number, status, id);


-- A template Meta approved for this business to start a conversation with.
-- `status` mirrors Meta's approval, updated by the message_template_status_update
-- webhook; only an `approved` template may be sent. `params` is a JSON array
-- binding each {{n}} in `body` to a customer or order field, or to literal text.
CREATE TABLE message_templates (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    language TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('marketing', 'utility')),
    body TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'approved', 'rejected', 'paused', 'disabled')),
    meta_template_id TEXT,
    rejection_reason TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE(tenant_id, name, language),
    UNIQUE(id, tenant_id)
);

CREATE INDEX idx_message_templates_tenant ON message_templates(tenant_id, status);

-- One send of a template to a group of customers, now or at `scheduled_at`.
-- `audience` and `params` are JSON. A `scheduled` campaign fires from the
-- minute sweep; `sending` means recipients are still being queued, `sent` that
-- every recipient was settled (sent, skipped or failed).
CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    template_id TEXT NOT NULL,
    audience TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK(status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
    scheduled_at INTEGER,
    sent_at INTEGER,
    failure_reason TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE(id, tenant_id),
    FOREIGN KEY (template_id, tenant_id) REFERENCES message_templates(id, tenant_id)
);

CREATE INDEX idx_campaigns_due ON campaigns(status, scheduled_at);
CREATE INDEX idx_campaigns_tenant ON campaigns(tenant_id, created_at DESC);

-- One customer a campaign goes out to. `queued_at` stamps when its outbox row
-- was written; Meta's delivery statuses move `status` after that. A `skipped`
-- row names its reason (opted out, over the marketing cap, no phone).
CREATE TABLE campaign_recipients (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id TEXT NOT NULL,
    customer_id TEXT,
    phone_number TEXT NOT NULL,
    message_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'queued', 'skipped', 'sent', 'delivered', 'read', 'failed')),
    skip_reason TEXT,
    queued_at INTEGER,
    replied_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE(campaign_id, phone_number),
    FOREIGN KEY (campaign_id, tenant_id) REFERENCES campaigns(id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id)
);

CREATE INDEX idx_campaign_recipients_phone ON campaign_recipients(tenant_id, phone_number);
CREATE INDEX idx_campaign_recipients_campaign ON campaign_recipients(tenant_id, campaign_id, status);

-- A customer who asked for no marketing, by writing "baja", "stop" or
-- "no más mensajes", or by staff. A row means opted out; deleting it opts the
-- phone back in. Keyed by phone so a phone with no customer row is still held.
CREATE TABLE marketing_opt_outs (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,
    -- 'message' when the customer wrote it, 'staff' otherwise.
    source TEXT NOT NULL CHECK(source IN ('message', 'staff')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    PRIMARY KEY (tenant_id, phone_number)
);

-- One abandoned-cart reminder per order. Cleared never: a reminded order is
-- not reminded again.
ALTER TABLE orders ADD COLUMN cart_reminder_sent_at INTEGER;

-- The inactive reminder the customer last got. A spell ends when the customer
-- writes or has a newer delivered order, so a newer spell compares against it.
ALTER TABLE customers ADD COLUMN inactive_reminder_sent_at INTEGER;

-- The last marketing send a phone got, from any sender (campaign or
-- reminder). Written where the outbox row is written, so the cap sees every
-- marketing send, not only campaigns. `message_id` is the `messages` row of the
-- send that holds the claim; that send's inserts are conditional on it.
CREATE TABLE marketing_sends (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (tenant_id, phone_number)
);
