-- Tenant-scoped secrets, AES-256-GCM encrypted under SECRETS_KEY like
-- channel_secrets. The first is the tenant's Cálidda password; the non-secret
-- parts of that login live in tenant_settings.
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
