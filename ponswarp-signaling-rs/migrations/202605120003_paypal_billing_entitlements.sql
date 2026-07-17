CREATE TABLE IF NOT EXISTS paypal_events (
    id text PRIMARY KEY,
    event_type text NOT NULL,
    created_at bigint NOT NULL,
    processed_at bigint NOT NULL
);

ALTER TABLE drop_passes
    ADD COLUMN IF NOT EXISTS paypal_order_id text UNIQUE;

ALTER TABLE drop_passes
    ADD COLUMN IF NOT EXISTS paypal_capture_id text UNIQUE;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS paypal_subscription_id text UNIQUE;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS paypal_plan_id text;

CREATE INDEX IF NOT EXISTS idx_drop_passes_paypal_order
    ON drop_passes(paypal_order_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_paypal_subscription
    ON subscriptions(paypal_subscription_id);
