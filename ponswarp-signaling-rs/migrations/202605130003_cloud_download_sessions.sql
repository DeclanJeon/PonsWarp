CREATE TABLE IF NOT EXISTS cloud_download_sessions (
    id uuid PRIMARY KEY,
    share_id text NOT NULL REFERENCES cloud_shares(id) ON DELETE CASCADE,
    token_hash text UNIQUE NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    counted_at bigint
);

CREATE INDEX IF NOT EXISTS idx_cloud_download_sessions_share_id
    ON cloud_download_sessions(share_id);

CREATE INDEX IF NOT EXISTS idx_cloud_download_sessions_expires_at
    ON cloud_download_sessions(expires_at);
