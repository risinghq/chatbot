-- A session is either a browser login, carried in the `session` cookie, or an
-- API token that a program sends as `Authorization: Bearer`. A token has a
-- name its owner chose and a fixed expiry; a browser session slides forward.
-- Each kind is accepted only on its own transport.
ALTER TABLE session ADD COLUMN kind TEXT NOT NULL DEFAULT 'browser'
    CHECK (kind IN ('browser', 'token'));
ALTER TABLE session ADD COLUMN name TEXT;
ALTER TABLE session ADD COLUMN created_at INTEGER;
ALTER TABLE session ADD COLUMN last_used_at INTEGER;
