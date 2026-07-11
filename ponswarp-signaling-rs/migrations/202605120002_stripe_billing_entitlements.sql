CREATE TABLE IF NOT EXISTS stripe_events (
    id text PRIMARY KEY,
    event_type text NOT NULL,
    created_at bigint NOT NULL,
    processed_at bigint NOT NULL
);

ALTER TABLE drop_passes
    ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text UNIQUE;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text UNIQUE;

ALTER TABLE subscriptions
    ALTER COLUMN stripe_subscription_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_drop_passes_checkout_session
    ON drop_passes(stripe_checkout_session_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_checkout_session
    ON subscriptions(stripe_checkout_session_id);
