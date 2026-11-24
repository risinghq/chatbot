-- TENANTS & USERS
-- A tenant is one business using VendeYa. Each table of business data below
-- has a `tenant_id` naming the tenant that owns the row. It is nullable only in
-- `notification_traces` and `audit_log`, whose rows can belong to the platform.
CREATE TABLE tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    -- What a business sells. It shapes the catalog forms (sizes and colours
    -- for clothing, weights for food). Null until the owner answers the
    -- welcome step.
    business_kind TEXT
        CHECK(business_kind IN ('clothing', 'accessories', 'beauty', 'electronics', 'pets', 'food', 'hardware', 'services', 'other'))
);

CREATE INDEX idx_tenants_status ON tenants(status);

-- A user is one person across every business. What they may do in a business
-- is their membership's role. The email is the login, compared without case.
-- `is_platform_operator` marks VendeYa's own staff. They need no membership to
-- act in a tenant, and a promoted account keeps the memberships it already had.
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    phone_number TEXT,
    is_platform_operator INTEGER NOT NULL DEFAULT 0 CHECK(is_platform_operator IN (0, 1)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    created_by TEXT REFERENCES users(id)
);

CREATE INDEX idx_users_active ON users(is_active);
CREATE INDEX idx_users_platform_operator ON users(is_platform_operator);

-- `is_available` is the agent's own switch, and it lives here rather than on the
-- account: someone who sells for two businesses goes offline for one of them
-- without dropping out of the other's assignment rotation.
CREATE TABLE tenant_memberships (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('admin', 'developer', 'supervisor', 'sales_agent')),
    is_available INTEGER NOT NULL DEFAULT 1 CHECK(is_available IN (0, 1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    created_by TEXT REFERENCES users(id),
    UNIQUE(tenant_id, user_id)
);

CREATE INDEX idx_memberships_user ON tenant_memberships(user_id);
CREATE INDEX idx_memberships_tenant_role ON tenant_memberships(tenant_id, role, is_available);

-- A session is either a browser login, carried in the `session` cookie, or an
-- API token that a program sends as `Authorization: Bearer`. A token has a
-- name its owner chose and a fixed expiry; a browser session slides forward.
-- Each kind is accepted only on its own transport.
-- `active_tenant_id` is the tenant scope the session is acting in. NULL means
-- no tenant is pinned. A platform operator then gets the cross-tenant view. A
-- member has no scope until they pick a tenant.
CREATE TABLE session (
    id TEXT NOT NULL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    active_tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'browser' CHECK(kind IN ('browser', 'token')),
    name TEXT,
    created_at INTEGER,
    last_used_at INTEGER
);

CREATE INDEX idx_session_user ON session(user_id);

-- An invitation lets one person join a business with a role. The link carries
-- a random token, and only its SHA-256 hash is stored, as with a session id. It
-- is spent when accepted and expires at `expires_at`.
CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK(role IN ('admin', 'developer', 'supervisor', 'sales_agent')),
    token_hash TEXT UNIQUE NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_invitations_tenant ON invitations(tenant_id, accepted_at);

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
    UNIQUE(tenant_id, endpoint)
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(tenant_id, user_id);


-- CHANNELS
-- Encrypted credential store. Values are AES-256-GCM ciphertext with the tag
-- appended, which cannot be decrypted without the key in SECRETS_KEY.
CREATE TABLE channel_secrets (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('access_token', 'verify_token', 'app_secret')),
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    key_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
);

CREATE INDEX idx_channel_secrets_tenant ON channel_secrets(tenant_id);

-- Tenant-scoped secrets, AES-256-GCM encrypted under SECRETS_KEY like
-- channel_secrets: the tenant's OpenAI key and, when it sells on Cálidda
-- credit, its Cálidda password. The non-secret parts live in tenant_settings.
CREATE TABLE tenant_secrets (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    key_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    UNIQUE(tenant_id, key)
);

CREATE INDEX idx_tenant_secrets_tenant ON tenant_secrets(tenant_id);

-- One row per channel the business sells through: a WhatsApp number, an
-- Instagram professional account, or the built-in simulator.
CREATE TABLE channel_accounts (
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

CREATE INDEX idx_channel_accounts_tenant ON channel_accounts(tenant_id, status);
CREATE INDEX idx_channel_accounts_waba ON channel_accounts(waba_id);


-- CONVERSATIONS & MESSAGES
-- Identity is (tenant, channel account, contact phone number): the same person
-- writing to two businesses, or to two of one business's numbers, is two
-- separate conversations. The customer is the `customers` row with the same
-- phone number.
CREATE TABLE conversations (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel_account_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'human_takeover', 'closed')),
    handover_reason TEXT,
    is_simulation INTEGER DEFAULT 0 CHECK(is_simulation IN (0, 1)),
    last_activity_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    assigned_agent TEXT REFERENCES users(id),
    assignment_notified_at INTEGER,
    -- The ad this contact last came in through. `ad_received_at` is the
    -- message's WhatsApp timestamp. A later ad message replaces these; a
    -- plain message does not touch them. All four stay NULL on a contact
    -- that never clicked an ad.
    ad_source_id TEXT,
    ad_headline TEXT,
    ad_ctwa_clid TEXT,
    ad_received_at INTEGER,
    PRIMARY KEY (tenant_id, channel_account_id, phone_number),
    FOREIGN KEY (channel_account_id, tenant_id)
        REFERENCES channel_accounts(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_conversations_updated ON conversations(tenant_id, last_activity_at DESC);
CREATE INDEX idx_conversations_status ON conversations(tenant_id, status);
CREATE INDEX idx_conversations_assigned ON conversations(tenant_id, assigned_agent);
CREATE INDEX idx_conversations_phone ON conversations(phone_number);
CREATE INDEX idx_conversations_ad ON conversations(tenant_id, ad_source_id)
    WHERE ad_source_id IS NOT NULL;

-- A row means the person holding the conversation has been alerted and has not
-- answered since. An escalation or a customer message adds it. A manual reply,
-- a change of the assigned agent, a reset or an undelivered alert removes it.
CREATE TABLE unread_alerts (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel_account_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    alerted_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, channel_account_id, phone_number),
    FOREIGN KEY (channel_account_id, tenant_id)
        REFERENCES channel_accounts(id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, channel_account_id, phone_number)
        REFERENCES conversations(tenant_id, channel_account_id, phone_number) ON DELETE CASCADE
);

-- Any statement that sets `assigned_agent` hands the conversation to someone
-- who has not been alerted about it: assignment, reassignment, decline,
-- takeover, release, an agent's removal. This one trigger covers every writer.
CREATE TRIGGER conversations_assignment_clears_unread_alert
AFTER UPDATE OF assigned_agent ON conversations
BEGIN
    DELETE FROM unread_alerts
    WHERE tenant_id = NEW.tenant_id
      AND channel_account_id = NEW.channel_account_id
      AND phone_number = NEW.phone_number;
END;

CREATE TABLE messages (
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

CREATE INDEX idx_messages_phone ON messages(tenant_id, channel_account_id, phone_number, created_at DESC);
CREATE INDEX idx_messages_whatsapp_id ON messages(whatsapp_message_id);
CREATE INDEX idx_messages_created ON messages(tenant_id, created_at);

CREATE TABLE message_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel_account_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    message_text TEXT NOT NULL,
    message_id TEXT UNIQUE NOT NULL,
    whatsapp_timestamp INTEGER NOT NULL,
    quoted_message_context TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
    last_error TEXT,
    -- Turns that ended without a reply: a throw, or a Durable Object instance
    -- that ended mid-turn. The states are in conversation/message-inbox.ts.
    attempts INTEGER NOT NULL DEFAULT 0,
    -- NULL until the handoff of a `failed` row alerts a person. Only that
    -- handoff writes it, and it is never cleared.
    handed_off_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    processed_at INTEGER,
    FOREIGN KEY (channel_account_id, tenant_id)
        REFERENCES channel_accounts(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_message_inbox_pending ON message_inbox(status, tenant_id, channel_account_id, phone_number, created_at);

-- One outbound reply whose send failed and may still go out. `message_id` is the
-- `messages` row this row updates, so a retry never writes a second row, and it
-- is where the product an image showed is recorded. The states and who moves
-- them are in conversation/outbox.ts.
-- `handed_off_at` is NULL until the handoff of a `failed` row alerts a person.
-- Only that handoff writes it, only on a `failed` row, and it is never cleared.
CREATE TABLE outbox (
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

CREATE INDEX idx_outbox_due ON outbox(status, next_attempt_at);
CREATE INDEX idx_outbox_conversation ON outbox(tenant_id, channel_account_id, phone_number, status, id);


-- CATALOG & STOCK
-- Stored bytes: catalog images, signed contracts and call recordings.
CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('catalog_image', 'contract', 'recording')),
    -- 'public' bytes are reachable without a session. Catalog images are public
    -- because Meta's servers fetch their `link` with no credentials. Their ids
    -- are random and unguessable, and the row still records the owning tenant so
    -- catalog reads stay scoped. 'private' bytes are only reachable through
    -- /api/assets/:id, which checks tenant scope.
    visibility TEXT NOT NULL CHECK(visibility IN ('public', 'private')),
    storage_key TEXT NOT NULL,
    -- For a contract or recording upload it starts as the browser's `File.type`.
    -- It holds a value only when the kind's allowlist in
    -- domains/assets/content-types.ts accepts it. Null means no type was
    -- recorded: none declared or one not served.
    -- Private bytes go out as an attachment regardless, so this column labels a
    -- download and never decides what a browser renders.
    content_type TEXT,
    byte_size INTEGER,
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
);

CREATE INDEX idx_assets_tenant ON assets(tenant_id, kind);

-- Lets a product image reference the pair, so it cannot place one tenant's
-- asset on another tenant's product.
CREATE UNIQUE INDEX idx_assets_id_tenant ON assets(id, tenant_id);

-- A product sells as one or more variants. Each variant has its own SKU, price
-- and stock. Stock changes only through a movement in the ledger; the level is
-- the running sum of its movements, kept in the same batch as each insert.
CREATE TABLE products (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    brand TEXT,
    model TEXT,
    specs_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft', 'active', 'archived')),
    shopify_product_id TEXT
);

CREATE INDEX idx_products_category ON products(tenant_id, category);

-- Lets a variant reference the pair, so it cannot name one tenant while its
-- product belongs to another.
CREATE UNIQUE INDEX idx_products_id_tenant ON products(id, tenant_id);

-- The ids a sync keys on are nullable: null for catalog a person entered by
-- hand.
CREATE UNIQUE INDEX idx_products_shopify_id
    ON products(tenant_id, shopify_product_id);

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
    shopify_variant_id TEXT,
    shopify_inventory_item_id TEXT,
    UNIQUE(tenant_id, sku),
    UNIQUE(id, tenant_id),
    FOREIGN KEY (product_id, tenant_id)
        REFERENCES products(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_variants_product ON product_variants(tenant_id, product_id);
CREATE UNIQUE INDEX idx_variants_shopify_id
    ON product_variants(tenant_id, shopify_variant_id);
CREATE INDEX idx_variants_shopify_item
    ON product_variants(tenant_id, shopify_inventory_item_id);

-- A product's photos, in the order a buyer sees them. The first is the cover.
-- The bytes and their public key belong to the asset row; this table only
-- places an asset on a product.
CREATE TABLE product_images (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    shopify_image_id TEXT,
    UNIQUE(asset_id),
    FOREIGN KEY (product_id, tenant_id)
        REFERENCES products(id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id, tenant_id)
        REFERENCES assets(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_product_images_product
    ON product_images(tenant_id, product_id, position);
CREATE INDEX idx_product_images_shopify_id
    ON product_images(tenant_id, shopify_image_id);

-- Which variants a photo shows. A photo of the red polo shows every size in
-- red. A photo with no rows here shows the product as a whole and goes with
-- every variant. The service checks the variant and the photo share a product.
CREATE TABLE product_image_variants (
    image_id TEXT NOT NULL REFERENCES product_images(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    PRIMARY KEY (image_id, variant_id),
    FOREIGN KEY (variant_id, tenant_id)
        REFERENCES product_variants(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_product_image_variants_variant
    ON product_image_variants(tenant_id, variant_id);

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


-- ORDERS & PAYMENTS
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
    -- The inactive reminder the customer last got. A spell ends when the
    -- customer writes or has a newer delivered order, so a newer spell
    -- compares against it.
    inactive_reminder_sent_at INTEGER,
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
    -- No ON DELETE: a customer with orders cannot be deleted, so an order keeps
    -- its buyer.
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
    -- One abandoned-cart reminder per order. Cleared never: a reminded order
    -- is not reminded again.
    cart_reminder_sent_at INTEGER,
    -- The order copies the conversation's ad at creation when the click is
    -- still inside the window, so a later click does not rewrite the sale's
    -- source.
    ad_source_id TEXT,
    ad_headline TEXT,
    -- The Shopify order id a confirmed order was written back as.
    shopify_order_id TEXT,
    UNIQUE(tenant_id, number),
    UNIQUE(id, tenant_id),
    FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id),
    FOREIGN KEY (channel_account_id, tenant_id) REFERENCES channel_accounts(id, tenant_id),
    FOREIGN KEY (location_id, tenant_id) REFERENCES stock_locations(id, tenant_id)
);

CREATE INDEX idx_orders_status ON orders(tenant_id, status, id DESC);
CREATE INDEX idx_orders_customer ON orders(tenant_id, customer_id);
CREATE INDEX idx_orders_created_by ON orders(tenant_id, created_by);
CREATE INDEX idx_orders_created ON orders(tenant_id, created_at);
CREATE INDEX idx_orders_ad ON orders(tenant_id, ad_source_id)
    WHERE ad_source_id IS NOT NULL;

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

CREATE TABLE stock_movements (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('receive', 'adjust', 'reserve', 'release', 'ship')),
    -- Positive for every kind but `adjust`, which carries the signed
    -- correction.
    quantity INTEGER NOT NULL CHECK(quantity != 0),
    note TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    -- The order a reserve, release or ship belongs to. Null for receive and
    -- adjust.
    order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
    FOREIGN KEY (variant_id, tenant_id)
        REFERENCES product_variants(id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (location_id, tenant_id)
        REFERENCES stock_locations(id, tenant_id) ON DELETE CASCADE
);

-- v7 ids sort by time, so `id DESC` is newest first.
CREATE INDEX idx_stock_movements_variant ON stock_movements(tenant_id, variant_id, id DESC);
CREATE INDEX idx_stock_movements_tenant ON stock_movements(tenant_id, id DESC);


-- CAMPAIGNS
-- Campaigns and reminders send WhatsApp message templates, which Meta requires
-- outside the 24-hour window.
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


-- INTEGRATIONS
-- A business that sells on Shopify connects its store: the catalog follows
-- Shopify, and a confirmed VendeYa order is written back as a Shopify order.
-- This is the non-secret half of the connection. The Admin API token and the
-- webhook signing secret live in tenant_secrets, encrypted like the other
-- keys.
CREATE TABLE shopify_connections (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    shop_domain TEXT NOT NULL,
    last_synced_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
);

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


-- ANALYTICS & PLATFORM
CREATE TABLE llm_calls (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    channel_account_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    operation TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    user_message TEXT NOT NULL,
    response TEXT,
    status TEXT NOT NULL CHECK(status IN ('success', 'error')),
    error_type TEXT,
    error_message TEXT,
    latency_ms INTEGER,
    tokens_prompt INTEGER,
    tokens_completion INTEGER,
    tokens_total INTEGER,
    context_metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    FOREIGN KEY (channel_account_id, tenant_id)
        REFERENCES channel_accounts(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_llm_calls_phone ON llm_calls(tenant_id, phone_number, created_at DESC);
CREATE INDEX idx_llm_calls_operation ON llm_calls(tenant_id, operation, created_at DESC);
CREATE INDEX idx_llm_calls_status ON llm_calls(tenant_id, status, created_at DESC);
CREATE INDEX idx_llm_calls_created ON llm_calls(tenant_id, created_at DESC);

CREATE TABLE notification_traces (
    id TEXT PRIMARY KEY,
    -- Null for a few events, such as provider outages affecting the whole
    -- platform, that are not attributable to one tenant. The alert goes out on
    -- the platform operations account (`ChannelAccountService.getPlatformOps`).
    -- The trace is marked failed when no such account is configured.
    tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
    trace_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    rule_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('sent', 'skipped', 'failed')),
    reason TEXT,
    content_snapshot TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
);

CREATE INDEX idx_notification_traces_trace_id ON notification_traces(trace_id);
CREATE INDEX idx_notification_traces_created_at ON notification_traces(tenant_id, created_at DESC);

-- `tenant_id` is nullable: platform operators also act outside any tenant.
-- `user_id` is null for an action no user took. `actor` always says who did it:
-- `user:<user id>` for a person, `cli:<operating-system user>` for the terminal.
CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
);

CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at DESC);

-- Genuinely global platform configuration: the shared Calidda provider kill
-- switches and the operations channel. Only platform operators may write it.
CREATE TABLE system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
);

-- Per-tenant configuration (agent round-robin cursor).
CREATE TABLE tenant_settings (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    PRIMARY KEY (tenant_id, key)
);
