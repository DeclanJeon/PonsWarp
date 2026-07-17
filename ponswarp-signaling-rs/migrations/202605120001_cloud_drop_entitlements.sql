CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY,
    email text UNIQUE NOT NULL,
    created_at bigint NOT NULL,
    stripe_customer_id text UNIQUE,
    plan text NOT NULL DEFAULT 'free'
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    stripe_subscription_id text UNIQUE NOT NULL,
    status text NOT NULL,
    current_period_start bigint,
    current_period_end bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS drop_passes (
    id uuid PRIMARY KEY,
    user_id uuid REFERENCES users(id),
    email text,
    stripe_payment_intent_id text UNIQUE,
    sku text NOT NULL,
    status text NOT NULL,
    max_total_bytes bigint NOT NULL,
    max_file_bytes bigint NOT NULL,
    retention_seconds bigint NOT NULL,
    remaining_uses int NOT NULL DEFAULT 1,
    created_at bigint NOT NULL,
    expires_at bigint
);

CREATE TABLE IF NOT EXISTS cloud_shares (
    id text PRIMARY KEY,
    owner_user_id uuid REFERENCES users(id),
    drop_pass_id uuid REFERENCES drop_passes(id),
    plan_snapshot jsonb NOT NULL,
    root_name text NOT NULL,
    total_size bigint NOT NULL,
    total_files int NOT NULL,
    completed boolean NOT NULL DEFAULT false,
    password_hash text,
    download_limit int,
    download_count int NOT NULL DEFAULT 0,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    deleted_at bigint
);

CREATE TABLE IF NOT EXISTS cloud_share_files (
    id text PRIMARY KEY,
    share_id text NOT NULL REFERENCES cloud_shares(id) ON DELETE CASCADE,
    name text NOT NULL,
    path text NOT NULL,
    size bigint NOT NULL,
    content_type text NOT NULL,
    last_modified bigint,
    object_key text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_shares_expires_at
    ON cloud_shares(expires_at)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_share_files_share_id
    ON cloud_share_files(share_id);

CREATE TABLE IF NOT EXISTS cloud_usage_events (
    id uuid PRIMARY KEY,
    user_id uuid REFERENCES users(id),
    share_id text REFERENCES cloud_shares(id) ON DELETE SET NULL,
    event_type text NOT NULL,
    bytes bigint NOT NULL DEFAULT 0,
    created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_usage_events_user_created
    ON cloud_usage_events(user_id, created_at);

