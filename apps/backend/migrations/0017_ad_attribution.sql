-- Click-to-WhatsApp ad attribution. A message that arrives from an ad carries
-- Meta's `referral` object; the conversation keeps the latest ad that sent the
-- customer, and an order filed inside the attribution window records it.

-- The ad this contact last came in through. `ad_received_at` is the message's
-- WhatsApp timestamp. A later ad message replaces these; a plain message does
-- not touch them. All four stay NULL on a contact that never clicked an ad.
ALTER TABLE conversations ADD COLUMN ad_source_id TEXT;
ALTER TABLE conversations ADD COLUMN ad_headline TEXT;
ALTER TABLE conversations ADD COLUMN ad_ctwa_clid TEXT;
ALTER TABLE conversations ADD COLUMN ad_received_at INTEGER;

-- The order copies the conversation's ad at creation when the click is still
-- inside the window, so a later click does not rewrite the sale's source.
ALTER TABLE orders ADD COLUMN ad_source_id TEXT;
ALTER TABLE orders ADD COLUMN ad_headline TEXT;

CREATE INDEX idx_conversations_ad ON conversations(tenant_id, ad_source_id)
    WHERE ad_source_id IS NOT NULL;
CREATE INDEX idx_orders_ad ON orders(tenant_id, ad_source_id)
    WHERE ad_source_id IS NOT NULL;
