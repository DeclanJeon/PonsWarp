CREATE TABLE IF NOT EXISTS lemonsqueezy_events (
    id text PRIMARY KEY,
    event_type text NOT NULL,
    created_at bigint NOT NULL,
    processed_at bigint NOT NULL
);

ALTER TABLE drop_passes
    ADD COLUMN IF NOT EXISTS lemonsqueezy_order_id text UNIQUE;

ALTER TABLE drop_passes
    ADD COLUMN IF NOT EXISTS lemonsqueezy_checkout_ref text UNIQUE;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS lemonsqueezy_subscription_id text UNIQUE;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS lemonsqueezy_checkout_ref text UNIQUE;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS lemonsqueezy_variant_id text;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS lemonsqueezy_customer_id text;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS payment_update_url text;

CREATE INDEX IF NOT EXISTS idx_drop_passes_lemonsqueezy_order
    ON drop_passes(lemonsqueezy_order_id);

CREATE INDEX IF NOT EXISTS idx_drop_passes_lemonsqueezy_checkout_ref
    ON drop_passes(lemonsqueezy_checkout_ref);

CREATE INDEX IF NOT EXISTS idx_subscriptions_lemonsqueezy_subscription
    ON subscriptions(lemonsqueezy_subscription_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_lemonsqueezy_checkout_ref
    ON subscriptions(lemonsqueezy_checkout_ref);
