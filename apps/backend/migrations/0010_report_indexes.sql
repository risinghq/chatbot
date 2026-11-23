-- The reports read a business's messages, orders and model calls by time
-- range. Messages were indexed only per conversation, and orders only by
-- status, so a range read scanned every row of the business.
CREATE INDEX idx_messages_created ON messages(tenant_id, created_at);
CREATE INDEX idx_orders_created ON orders(tenant_id, created_at);
