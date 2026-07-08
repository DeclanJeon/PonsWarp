-- PonsWarp Mesh Coordinator persistence foundation.
-- G002 creates authoritative metadata tables for Postgres-backed mesh APIs.
CREATE SCHEMA IF NOT EXISTS grid;
SET search_path TO grid, public;

CREATE TABLE IF NOT EXISTS mesh_workspaces (
    workspace_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS mesh_workspace_members (
    workspace_id TEXT NOT NULL REFERENCES mesh_workspaces(workspace_id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, member_id)
);

CREATE TABLE IF NOT EXISTS mesh_nodes (
    workspace_id TEXT NOT NULL REFERENCES mesh_workspaces(workspace_id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    status TEXT NOT NULL,
    capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, node_id)
);

CREATE TABLE IF NOT EXISTS mesh_node_tokens (
    workspace_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT,
    revoked_at BIGINT,
    PRIMARY KEY (workspace_id, node_id, token_hash),
    FOREIGN KEY (workspace_id, node_id) REFERENCES mesh_nodes(workspace_id, node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mesh_presence (
    workspace_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    online BOOLEAN NOT NULL,
    endpoint_hints JSONB NOT NULL DEFAULT '{}'::jsonb,
    load JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, node_id),
    FOREIGN KEY (workspace_id, node_id) REFERENCES mesh_nodes(workspace_id, node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mesh_files (
    workspace_id TEXT NOT NULL REFERENCES mesh_workspaces(workspace_id) ON DELETE CASCADE,
    file_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    piece_size BIGINT NOT NULL,
    piece_count BIGINT NOT NULL,
    manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    tags JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by_node_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, file_id)
);

CREATE TABLE IF NOT EXISTS mesh_availability (
    workspace_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    complete BOOLEAN NOT NULL DEFAULT FALSE,
    verified_ranges JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at BIGINT NOT NULL,
    advertise_until BIGINT,
    PRIMARY KEY (workspace_id, file_id, node_id),
    FOREIGN KEY (workspace_id, file_id) REFERENCES mesh_files(workspace_id, file_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, node_id) REFERENCES mesh_nodes(workspace_id, node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mesh_shares (
    code TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    created_by_node_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    revoked_at BIGINT,
    capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL,
    FOREIGN KEY (workspace_id, file_id) REFERENCES mesh_files(workspace_id, file_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mesh_events (
    event_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES mesh_workspaces(workspace_id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS mesh_rate_limits (
    bucket_key TEXT PRIMARY KEY,
    tokens DOUBLE PRECISION NOT NULL,
    capacity DOUBLE PRECISION NOT NULL,
    refill_per_second DOUBLE PRECISION NOT NULL,
    updated_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mesh_presence_fresh ON mesh_presence (workspace_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_mesh_availability_file ON mesh_availability (workspace_id, file_id);
CREATE INDEX IF NOT EXISTS idx_mesh_shares_active ON mesh_shares (expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_mesh_events_workspace_created ON mesh_events (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mesh_node_tokens_active ON mesh_node_tokens (workspace_id, node_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_mesh_rate_limits_expires ON mesh_rate_limits (expires_at);
