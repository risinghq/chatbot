-- Each channel account gets its own Meta app secret, stored encrypted like the
-- access token, so a deployment can serve numbers on more than one Meta app.
-- SQLite cannot widen a CHECK constraint, so channel_secrets is rebuilt with
-- 'app_secret' among its purposes. The rebuild drops the table; with foreign
-- keys enforced, that delete fires ON DELETE SET NULL on channel_accounts, so
-- its secret references are saved first and restored afterwards.
CREATE TABLE channel_account_secret_refs AS
    SELECT id, access_token_secret_id, verify_token_secret_id
    FROM channel_accounts;

CREATE TABLE channel_secrets_new (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('access_token', 'verify_token', 'app_secret')),
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    key_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000)
);

INSERT INTO channel_secrets_new SELECT * FROM channel_secrets;
DROP TABLE channel_secrets;
ALTER TABLE channel_secrets_new RENAME TO channel_secrets;
CREATE INDEX idx_channel_secrets_tenant ON channel_secrets(tenant_id);

UPDATE channel_accounts SET
    access_token_secret_id = (
        SELECT access_token_secret_id FROM channel_account_secret_refs
        WHERE channel_account_secret_refs.id = channel_accounts.id
    ),
    verify_token_secret_id = (
        SELECT verify_token_secret_id FROM channel_account_secret_refs
        WHERE channel_account_secret_refs.id = channel_accounts.id
    );

DROP TABLE channel_account_secret_refs;

ALTER TABLE channel_accounts
    ADD COLUMN app_secret_secret_id TEXT REFERENCES channel_secrets(id) ON DELETE SET NULL;
