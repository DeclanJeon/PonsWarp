ALTER TABLE users
    ADD COLUMN IF NOT EXISTS google_sub text UNIQUE;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS name text;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS picture_url text;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS updated_at bigint;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_login_at bigint;

CREATE TABLE IF NOT EXISTS oauth_states (
    state text PRIMARY KEY,
    return_path text NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    consumed_at bigint
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at
    ON oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text UNIQUE NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    last_seen_at bigint NOT NULL,
    revoked_at bigint
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
    ON auth_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
    ON auth_sessions(expires_at)
    WHERE revoked_at IS NULL;
