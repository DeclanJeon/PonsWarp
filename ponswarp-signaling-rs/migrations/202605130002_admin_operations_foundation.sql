CREATE TABLE IF NOT EXISTS admin_members (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    created_by uuid REFERENCES users(id),
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_members_status
    ON admin_members(status);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id uuid PRIMARY KEY,
    actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    reason text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip inet,
    user_agent text,
    request_id text,
    created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_actor_created
    ON admin_audit_logs(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target_created
    ON admin_audit_logs(target_type, target_id, created_at DESC);
