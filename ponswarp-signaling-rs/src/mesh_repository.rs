use anyhow::{Context, Result};
use dashmap::DashMap;
use futures::future::{BoxFuture, FutureExt};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::sync::{Arc, Mutex};

use crate::config::{Config, MeshStorage};
use crate::mesh_domain::{
    MeshAvailability, MeshCandidate, MeshCleanupReport, MeshEvent, MeshFile, MeshNode,
    MeshPresence, MeshShare, MeshWorkspace,
};
use crate::mesh_security::SecretHash;

#[derive(Debug, Default)]
pub struct MeshState {
    pub workspaces: DashMap<String, MeshWorkspace>,
    pub nodes: DashMap<(String, String), MeshNode>,
    pub presence: DashMap<(String, String), MeshPresence>,
    pub files: DashMap<(String, String), MeshFile>,
    pub availability: DashMap<(String, String, String), MeshAvailability>,
    pub events: DashMap<String, MeshEvent>,
    pub shares: DashMap<String, MeshShare>,
    pub node_tokens: DashMap<(String, String), SecretHash>,
    pub quota_locks: DashMap<String, Arc<Mutex<()>>>,
    pub share_creation_lock: Mutex<()>,
    pub node_registration_lock: Mutex<()>,
}
#[derive(Debug, Clone, Copy)]
pub struct MeshRetentionPolicy {
    pub expired_share_retention_seconds: u64,
    pub stale_presence_retention_seconds: u64,
    pub event_retention_seconds: u64,
}

pub trait MeshRepository: Send + Sync {
    fn storage_name(&self) -> &'static str;
    fn create_workspace(&self, workspace: MeshWorkspace) -> BoxFuture<'_, Result<MeshWorkspace>>;
    fn get_workspace(&self, workspace_id: &str) -> BoxFuture<'_, Result<Option<MeshWorkspace>>>;
    fn register_node(&self, node: MeshNode) -> BoxFuture<'_, Result<MeshNode>>;
    fn register_node_with_token(
        &self,
        node: MeshNode,
        token_hash: Option<SecretHash>,
        created_at: u64,
    ) -> BoxFuture<'_, Result<MeshNode>>;
    fn register_node_with_token_and_audit(
        &self,
        node: MeshNode,
        token_hash: Option<SecretHash>,
        created_at: u64,
        event: MeshEvent,
    ) -> BoxFuture<'_, Result<MeshNode>>;
    fn get_node(
        &self,
        workspace_id: &str,
        node_id: &str,
    ) -> BoxFuture<'_, Result<Option<MeshNode>>>;
    fn heartbeat(&self, presence: MeshPresence) -> BoxFuture<'_, Result<MeshPresence>>;
    fn get_file(
        &self,
        workspace_id: &str,
        file_id: &str,
    ) -> BoxFuture<'_, Result<Option<MeshFile>>>;
    fn update_availability(
        &self,
        availability: MeshAvailability,
    ) -> BoxFuture<'_, Result<MeshAvailability>>;
    fn resolve_share(&self, code: &str) -> BoxFuture<'_, Result<Option<MeshShare>>>;
    fn revoke_share(&self, code: &str, revoked_at: u64)
        -> BoxFuture<'_, Result<Option<MeshShare>>>;
    fn issue_node_token_hash(
        &self,
        workspace_id: &str,
        node_id: &str,
        token_hash: SecretHash,
        created_at: u64,
    ) -> BoxFuture<'_, Result<SecretHash>>;
    fn get_active_node_token_hash(
        &self,
        workspace_id: &str,
        node_id: &str,
        token_id: &str,
        now: u64,
    ) -> BoxFuture<'_, Result<Option<SecretHash>>>;
    fn revoke_node_tokens(
        &self,
        workspace_id: &str,
        node_id: &str,
        revoked_at: u64,
    ) -> BoxFuture<'_, Result<u64>>;
    fn record_event(&self, event: MeshEvent) -> BoxFuture<'_, Result<MeshEvent>>;
    fn list_candidates(
        &self,
        workspace_id: &str,
        file_id: &str,
        now: u64,
    ) -> BoxFuture<'_, Result<Vec<MeshCandidate>>>;
    fn list_files(&self, workspace_id: &str) -> BoxFuture<'_, Result<Vec<MeshFile>>>;
    fn online_provider_count(
        &self,
        workspace_id: &str,
        file_id: &str,
        now: u64,
    ) -> BoxFuture<'_, Result<usize>>;
    fn create_share_with_quota(
        &self,
        share: MeshShare,
        quota: usize,
        now: u64,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshShare>>>;
    fn publish_file_with_quota(
        &self,
        file: MeshFile,
        quota: usize,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshFile>>>;
    fn publish_file_with_availability(
        &self,
        file: MeshFile,
        availability: Option<MeshAvailability>,
        quota: usize,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshFile>>>;
    fn publish_file_with_availability_and_audit(
        &self,
        file: MeshFile,
        availability: Option<MeshAvailability>,
        quota: usize,
        event: MeshEvent,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshFile>>>;
    fn create_share_with_quota_and_audit(
        &self,
        share: MeshShare,
        quota: usize,
        now: u64,
        event: MeshEvent,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshShare>>>;
    fn revoke_share_with_audit(
        &self,
        code: &str,
        revoked_at: u64,
        event: MeshEvent,
    ) -> BoxFuture<'_, Result<Option<MeshShare>>>;
    fn cleanup_retention(
        &self,
        policy: MeshRetentionPolicy,
        now: u64,
    ) -> BoxFuture<'_, Result<MeshCleanupReport>>;
}
#[derive(Debug, PartialEq, Eq)]
pub enum MeshQuotaResult<T> {
    Created(T),
    Exceeded { current: usize, quota: usize },
    Conflict,
}

#[derive(Debug, Clone)]
pub struct InMemoryMeshRepository {
    state: Arc<MeshState>,
}

impl InMemoryMeshRepository {
    pub fn new(state: Arc<MeshState>) -> Self {
        Self { state }
    }

    pub fn state(&self) -> &Arc<MeshState> {
        &self.state
    }
}

impl MeshRepository for InMemoryMeshRepository {
    fn storage_name(&self) -> &'static str {
        "memory"
    }

    fn create_workspace(&self, workspace: MeshWorkspace) -> BoxFuture<'_, Result<MeshWorkspace>> {
        async move {
            self.state
                .workspaces
                .insert(workspace.workspace_id.clone(), workspace.clone());
            Ok(workspace)
        }
        .boxed()
    }

    fn get_workspace(&self, workspace_id: &str) -> BoxFuture<'_, Result<Option<MeshWorkspace>>> {
        let workspace_id = workspace_id.to_string();
        async move {
            Ok(self
                .state
                .workspaces
                .get(&workspace_id)
                .map(|entry| entry.clone()))
        }
        .boxed()
    }

    fn register_node(&self, node: MeshNode) -> BoxFuture<'_, Result<MeshNode>> {
        async move {
            self.state.nodes.insert(
                (node.workspace_id.clone(), node.node_id.clone()),
                node.clone(),
            );
            Ok(node)
        }
        .boxed()
    }
    fn register_node_with_token(
        &self,
        node: MeshNode,
        token_hash: Option<SecretHash>,
        _created_at: u64,
    ) -> BoxFuture<'_, Result<MeshNode>> {
        async move {
            let _guard = self
                .state
                .node_registration_lock
                .lock()
                .expect("node registration lock poisoned");
            self.state.nodes.insert(
                (node.workspace_id.clone(), node.node_id.clone()),
                node.clone(),
            );
            if let Some(token_hash) = token_hash {
                self.state.node_tokens.insert(
                    (node.workspace_id.clone(), node.node_id.clone()),
                    token_hash,
                );
            }
            Ok(node)
        }
        .boxed()
    }
    fn register_node_with_token_and_audit(
        &self,
        node: MeshNode,
        token_hash: Option<SecretHash>,
        _created_at: u64,
        event: MeshEvent,
    ) -> BoxFuture<'_, Result<MeshNode>> {
        async move {
            let _guard = self
                .state
                .node_registration_lock
                .lock()
                .expect("node registration lock poisoned");
            self.state.nodes.insert(
                (node.workspace_id.clone(), node.node_id.clone()),
                node.clone(),
            );
            if let Some(token_hash) = token_hash {
                self.state.node_tokens.insert(
                    (node.workspace_id.clone(), node.node_id.clone()),
                    token_hash,
                );
            }
            self.state.events.insert(event.event_id.clone(), event);
            Ok(node)
        }
        .boxed()
    }

    fn issue_node_token_hash(
        &self,
        workspace_id: &str,
        node_id: &str,
        token_hash: SecretHash,
        _created_at: u64,
    ) -> BoxFuture<'_, Result<SecretHash>> {
        let workspace_id = workspace_id.to_string();
        let node_id = node_id.to_string();
        async move {
            self.state
                .node_tokens
                .insert((workspace_id, node_id), token_hash.clone());
            Ok(token_hash)
        }
        .boxed()
    }

    fn get_active_node_token_hash(
        &self,
        workspace_id: &str,
        node_id: &str,
        token_id: &str,
        _now: u64,
    ) -> BoxFuture<'_, Result<Option<SecretHash>>> {
        let workspace_id = workspace_id.to_string();
        let node_id = node_id.to_string();
        let token_id = token_id.to_string();
        async move {
            Ok(self
                .state
                .node_tokens
                .get(&(workspace_id, node_id))
                .filter(|entry| entry.id == token_id)
                .map(|entry| entry.clone()))
        }
        .boxed()
    }

    fn revoke_node_tokens(
        &self,
        workspace_id: &str,
        node_id: &str,
        _revoked_at: u64,
    ) -> BoxFuture<'_, Result<u64>> {
        let workspace_id = workspace_id.to_string();
        let node_id = node_id.to_string();
        async move {
            Ok(self
                .state
                .node_tokens
                .remove(&(workspace_id, node_id))
                .map(|_| 1)
                .unwrap_or(0))
        }
        .boxed()
    }

    fn get_node(
        &self,
        workspace_id: &str,
        node_id: &str,
    ) -> BoxFuture<'_, Result<Option<MeshNode>>> {
        let workspace_id = workspace_id.to_string();
        let node_id = node_id.to_string();
        async move {
            Ok(self
                .state
                .nodes
                .get(&(workspace_id, node_id))
                .map(|entry| entry.clone()))
        }
        .boxed()
    }

    fn heartbeat(&self, presence: MeshPresence) -> BoxFuture<'_, Result<MeshPresence>> {
        async move {
            self.state.presence.insert(
                (presence.workspace_id.clone(), presence.node_id.clone()),
                presence.clone(),
            );
            Ok(presence)
        }
        .boxed()
    }

    fn list_files(&self, workspace_id: &str) -> BoxFuture<'_, Result<Vec<MeshFile>>> {
        let workspace_id = workspace_id.to_string();
        async move {
            Ok(self
                .state
                .files
                .iter()
                .filter(|entry| entry.key().0 == workspace_id)
                .map(|entry| entry.value().clone())
                .collect())
        }
        .boxed()
    }

    fn online_provider_count(
        &self,
        workspace_id: &str,
        file_id: &str,
        now: u64,
    ) -> BoxFuture<'_, Result<usize>> {
        let workspace_id = workspace_id.to_string();
        let file_id = file_id.to_string();
        async move {
            Ok(
                list_candidates_from_hot_cache(&self.state, &workspace_id, &file_id, now)
                    .into_iter()
                    .filter(|candidate| candidate.online)
                    .count(),
            )
        }
        .boxed()
    }

    fn publish_file_with_quota(
        &self,
        file: MeshFile,
        quota: usize,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshFile>>> {
        async move {
            let lock = self
                .state
                .quota_locks
                .entry(file.workspace_id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone();
            let _guard = lock.lock().expect("workspace quota lock poisoned");
            if !self
                .state
                .files
                .contains_key(&(file.workspace_id.clone(), file.file_id.clone()))
            {
                let current = self
                    .state
                    .files
                    .iter()
                    .filter(|entry| entry.key().0 == file.workspace_id)
                    .count();
                if current >= quota {
                    return Ok(MeshQuotaResult::Exceeded { current, quota });
                }
            }
            self.state.files.insert(
                (file.workspace_id.clone(), file.file_id.clone()),
                file.clone(),
            );
            Ok(MeshQuotaResult::Created(file))
        }
        .boxed()
    }

    fn publish_file_with_availability(
        &self,
        file: MeshFile,
        availability: Option<MeshAvailability>,
        quota: usize,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshFile>>> {
        async move {
            let lock = self
                .state
                .quota_locks
                .entry(file.workspace_id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone();
            let _guard = lock.lock().expect("workspace quota lock poisoned");
            if !self
                .state
                .files
                .contains_key(&(file.workspace_id.clone(), file.file_id.clone()))
            {
                let current = self
                    .state
                    .files
                    .iter()
                    .filter(|entry| entry.key().0 == file.workspace_id)
                    .count();
                if current >= quota {
                    return Ok(MeshQuotaResult::Exceeded { current, quota });
                }
            }
            self.state.files.insert(
                (file.workspace_id.clone(), file.file_id.clone()),
                file.clone(),
            );
            if let Some(availability) = availability {
                self.state.availability.insert(
                    (
                        availability.workspace_id.clone(),
                        availability.file_id.clone(),
                        availability.node_id.clone(),
                    ),
                    availability,
                );
            }
            Ok(MeshQuotaResult::Created(file))
        }
        .boxed()
    }
    fn publish_file_with_availability_and_audit(
        &self,
        file: MeshFile,
        availability: Option<MeshAvailability>,
        quota: usize,
        event: MeshEvent,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshFile>>> {
        async move {
            let lock = self
                .state
                .quota_locks
                .entry(file.workspace_id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone();
            let _guard = lock.lock().expect("workspace quota lock poisoned");
            if !self
                .state
                .files
                .contains_key(&(file.workspace_id.clone(), file.file_id.clone()))
            {
                let current = self
                    .state
                    .files
                    .iter()
                    .filter(|entry| entry.key().0 == file.workspace_id)
                    .count();
                if current >= quota {
                    return Ok(MeshQuotaResult::Exceeded { current, quota });
                }
            }
            self.state.files.insert(
                (file.workspace_id.clone(), file.file_id.clone()),
                file.clone(),
            );
            if let Some(availability) = availability {
                self.state.availability.insert(
                    (
                        availability.workspace_id.clone(),
                        availability.file_id.clone(),
                        availability.node_id.clone(),
                    ),
                    availability,
                );
            }
            self.state.events.insert(event.event_id.clone(), event);
            Ok(MeshQuotaResult::Created(file))
        }
        .boxed()
    }

    fn create_share_with_quota(
        &self,
        share: MeshShare,
        quota: usize,
        now: u64,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshShare>>> {
        async move {
            let _guard = self
                .state
                .share_creation_lock
                .lock()
                .expect("share creation lock poisoned");
            if self.state.shares.contains_key(&share.code) {
                return Ok(MeshQuotaResult::Conflict);
            }
            let current = self
                .state
                .shares
                .iter()
                .filter(|entry| {
                    entry.workspace_id == share.workspace_id
                        && entry.revoked_at.is_none()
                        && entry.expires_at > now
                })
                .count();
            if current >= quota {
                return Ok(MeshQuotaResult::Exceeded { current, quota });
            }
            self.state.shares.insert(share.code.clone(), share.clone());
            Ok(MeshQuotaResult::Created(share))
        }
        .boxed()
    }
    fn create_share_with_quota_and_audit(
        &self,
        share: MeshShare,
        quota: usize,
        now: u64,
        event: MeshEvent,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshShare>>> {
        async move {
            let _guard = self
                .state
                .share_creation_lock
                .lock()
                .expect("share creation lock poisoned");
            if self.state.shares.contains_key(&share.code) {
                return Ok(MeshQuotaResult::Conflict);
            }
            let current = self
                .state
                .shares
                .iter()
                .filter(|entry| {
                    entry.workspace_id == share.workspace_id
                        && entry.revoked_at.is_none()
                        && entry.expires_at > now
                })
                .count();
            if current >= quota {
                return Ok(MeshQuotaResult::Exceeded { current, quota });
            }
            self.state.shares.insert(share.code.clone(), share.clone());
            self.state.events.insert(event.event_id.clone(), event);
            Ok(MeshQuotaResult::Created(share))
        }
        .boxed()
    }

    fn get_file(
        &self,
        workspace_id: &str,
        file_id: &str,
    ) -> BoxFuture<'_, Result<Option<MeshFile>>> {
        let workspace_id = workspace_id.to_string();
        let file_id = file_id.to_string();
        async move {
            Ok(self
                .state
                .files
                .get(&(workspace_id, file_id))
                .map(|entry| entry.clone()))
        }
        .boxed()
    }

    fn update_availability(
        &self,
        availability: MeshAvailability,
    ) -> BoxFuture<'_, Result<MeshAvailability>> {
        async move {
            self.state.availability.insert(
                (
                    availability.workspace_id.clone(),
                    availability.file_id.clone(),
                    availability.node_id.clone(),
                ),
                availability.clone(),
            );
            Ok(availability)
        }
        .boxed()
    }

    fn resolve_share(&self, code: &str) -> BoxFuture<'_, Result<Option<MeshShare>>> {
        let code = code.to_string();
        async move { Ok(self.state.shares.get(&code).map(|entry| entry.clone())) }.boxed()
    }

    fn revoke_share(
        &self,
        code: &str,
        revoked_at: u64,
    ) -> BoxFuture<'_, Result<Option<MeshShare>>> {
        let code = code.to_string();
        async move {
            let Some(mut share) = self.state.shares.get_mut(&code) else {
                return Ok(None);
            };
            share.revoked_at = Some(revoked_at);
            Ok(Some(share.clone()))
        }
        .boxed()
    }
    fn revoke_share_with_audit(
        &self,
        code: &str,
        revoked_at: u64,
        event: MeshEvent,
    ) -> BoxFuture<'_, Result<Option<MeshShare>>> {
        let code = code.to_string();
        async move {
            let _guard = self
                .state
                .share_creation_lock
                .lock()
                .expect("share creation lock poisoned");
            let Some(mut share) = self.state.shares.get_mut(&code) else {
                return Ok(None);
            };
            share.revoked_at = Some(revoked_at);
            let share = share.clone();
            self.state.events.insert(event.event_id.clone(), event);
            Ok(Some(share))
        }
        .boxed()
    }

    fn record_event(&self, event: MeshEvent) -> BoxFuture<'_, Result<MeshEvent>> {
        async move {
            self.state
                .events
                .insert(event.event_id.clone(), event.clone());
            Ok(event)
        }
        .boxed()
    }
    fn list_candidates(
        &self,
        workspace_id: &str,
        file_id: &str,
        now: u64,
    ) -> BoxFuture<'_, Result<Vec<MeshCandidate>>> {
        let workspace_id = workspace_id.to_string();
        let file_id = file_id.to_string();
        async move {
            Ok(list_candidates_from_hot_cache(
                &self.state,
                &workspace_id,
                &file_id,
                now,
            ))
        }
        .boxed()
    }

    fn cleanup_retention(
        &self,
        policy: MeshRetentionPolicy,
        now: u64,
    ) -> BoxFuture<'_, Result<MeshCleanupReport>> {
        async move { Ok(cleanup_memory_mesh_state(&self.state, policy, now)) }.boxed()
    }
}

#[derive(Debug, Clone)]
pub struct PostgresMeshRepository {
    pool: PgPool,
}

impl PostgresMeshRepository {
    pub async fn from_config(config: &Config) -> Result<Option<Self>> {
        config.validate()?;
        if !config.mesh.enabled || config.mesh.storage != MeshStorage::Postgres {
            return Ok(None);
        }

        let pool = PgPoolOptions::new()
            .max_connections(config.database.max_connections)
            .connect(&config.database.url)
            .await
            .context("failed to connect to Postgres for mesh repository")?;

        if config.database.run_migrations {
            sqlx::migrate!("./migrations")
                .run(&pool)
                .await
                .context("failed to run mesh repository migrations")?;
        }

        Ok(Some(Self { pool }))
    }

    pub async fn from_pool(config: &Config, pool: PgPool) -> Result<Option<Self>> {
        config.validate()?;
        if !config.mesh.enabled || config.mesh.storage != MeshStorage::Postgres {
            return Ok(None);
        }
        if config.database.run_migrations {
            sqlx::migrate!("./migrations")
                .run(&pool)
                .await
                .context("failed to run mesh repository migrations")?;
        }
        Ok(Some(Self { pool }))
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

fn to_pg_i64(value: u64, field: &str) -> Result<i64> {
    i64::try_from(value).with_context(|| format!("{field} exceeds Postgres BIGINT range"))
}

fn from_pg_u64(value: i64, field: &str) -> Result<u64> {
    u64::try_from(value).with_context(|| format!("{field} is negative in Postgres"))
}

fn stored_token_hash(token_hash: &SecretHash) -> String {
    format!("{}:{}", token_hash.id, token_hash.hash)
}

fn parse_stored_token_hash(value: String) -> Result<SecretHash> {
    let Some((id, hash)) = value.split_once(':') else {
        anyhow::bail!("stored token hash has malformed encoding");
    };
    if id.is_empty() || hash.is_empty() || hash.contains(':') {
        anyhow::bail!("stored token hash has malformed encoding");
    }
    Ok(SecretHash {
        id: id.to_string(),
        hash: hash.to_string(),
    })
}

fn postgres_json(value: Value) -> Value {
    if value.is_null() {
        Value::Object(Default::default())
    } else {
        value
    }
}

fn workspace_from_row(row: &sqlx::postgres::PgRow) -> Result<MeshWorkspace> {
    Ok(MeshWorkspace {
        workspace_id: row.try_get("workspace_id")?,
        name: row.try_get("name")?,
        created_at: from_pg_u64(row.try_get("created_at")?, "created_at")?,
    })
}

fn node_from_row(row: &sqlx::postgres::PgRow) -> Result<MeshNode> {
    Ok(MeshNode {
        workspace_id: row.try_get("workspace_id")?,
        node_id: row.try_get("node_id")?,
        display_name: row.try_get("display_name")?,
        public_key: row.try_get("public_key")?,
        status: row.try_get("status")?,
        capabilities: postgres_json(row.try_get("capabilities")?),
        created_at: from_pg_u64(row.try_get("created_at")?, "created_at")?,
    })
}

fn presence_from_row(row: &sqlx::postgres::PgRow) -> Result<MeshPresence> {
    Ok(MeshPresence {
        workspace_id: row.try_get("workspace_id")?,
        node_id: row.try_get("node_id")?,
        online: row.try_get("online")?,
        endpoint_hints: postgres_json(row.try_get("endpoint_hints")?),
        load: postgres_json(row.try_get("load")?),
        updated_at: from_pg_u64(row.try_get("updated_at")?, "updated_at")?,
        expires_at: from_pg_u64(row.try_get("expires_at")?, "expires_at")?,
    })
}

fn file_from_row(row: &sqlx::postgres::PgRow) -> Result<MeshFile> {
    Ok(MeshFile {
        workspace_id: row.try_get("workspace_id")?,
        file_id: row.try_get("file_id")?,
        name: row.try_get("name")?,
        size_bytes: from_pg_u64(row.try_get("size_bytes")?, "size_bytes")?,
        piece_size: from_pg_u64(row.try_get("piece_size")?, "piece_size")?,
        piece_count: from_pg_u64(row.try_get("piece_count")?, "piece_count")?,
        manifest: postgres_json(row.try_get("manifest")?),
        tags: postgres_json(row.try_get("tags")?),
        created_by_node_id: row.try_get("created_by_node_id")?,
        created_at: from_pg_u64(row.try_get("created_at")?, "created_at")?,
    })
}

fn availability_from_row(row: &sqlx::postgres::PgRow) -> Result<MeshAvailability> {
    Ok(MeshAvailability {
        workspace_id: row.try_get("workspace_id")?,
        file_id: row.try_get("file_id")?,
        node_id: row.try_get("node_id")?,
        complete: row.try_get("complete")?,
        verified_ranges: postgres_json(row.try_get("verified_ranges")?),
        updated_at: from_pg_u64(row.try_get("updated_at")?, "updated_at")?,
        advertise_until: row
            .try_get::<Option<i64>, _>("advertise_until")?
            .map(|value| from_pg_u64(value, "advertise_until"))
            .transpose()?,
    })
}

fn share_from_row(row: &sqlx::postgres::PgRow) -> Result<MeshShare> {
    Ok(MeshShare {
        code: row.try_get("code")?,
        workspace_id: row.try_get("workspace_id")?,
        file_id: row.try_get("file_id")?,
        created_by_node_id: row.try_get("created_by_node_id")?,
        expires_at: from_pg_u64(row.try_get("expires_at")?, "expires_at")?,
        revoked_at: row
            .try_get::<Option<i64>, _>("revoked_at")?
            .map(|value| from_pg_u64(value, "revoked_at"))
            .transpose()?,
        capabilities: postgres_json(row.try_get("capabilities")?),
        created_at: from_pg_u64(row.try_get("created_at")?, "created_at")?,
    })
}

fn event_from_row(row: &sqlx::postgres::PgRow) -> Result<MeshEvent> {
    Ok(MeshEvent {
        event_id: row.try_get("event_id")?,
        workspace_id: row.try_get("workspace_id")?,
        event_type: row.try_get("event_type")?,
        payload: postgres_json(row.try_get("payload")?),
        created_at: from_pg_u64(row.try_get("created_at")?, "created_at")?,
    })
}

impl MeshRepository for PostgresMeshRepository {
    fn storage_name(&self) -> &'static str {
        "postgres"
    }
    fn list_files(&self, workspace_id: &str) -> BoxFuture<'_, Result<Vec<MeshFile>>> {
        let workspace_id = workspace_id.to_string();
        async move {
            let rows = sqlx::query("SELECT workspace_id, file_id, name, size_bytes, piece_size, piece_count, manifest, tags, created_by_node_id, created_at FROM mesh_files WHERE workspace_id = $1 ORDER BY created_at, file_id").bind(&workspace_id).fetch_all(&self.pool).await?;
            rows.iter().map(file_from_row).collect()
        }.boxed()
    }
    fn online_provider_count(
        &self,
        workspace_id: &str,
        file_id: &str,
        now: u64,
    ) -> BoxFuture<'_, Result<usize>> {
        let workspace_id = workspace_id.to_string();
        let file_id = file_id.to_string();
        async move {
            let row = sqlx::query(
                "SELECT COUNT(*) AS count
                 FROM mesh_availability a
                 JOIN mesh_presence p
                   ON p.workspace_id = a.workspace_id AND p.node_id = a.node_id
                 WHERE a.workspace_id = $1
                   AND a.file_id = $2
                   AND (a.advertise_until IS NULL OR a.advertise_until > $3)
                   AND p.online
                   AND p.expires_at > $3",
            )
            .bind(&workspace_id)
            .bind(&file_id)
            .bind(to_pg_i64(now, "now")?)
            .fetch_one(&self.pool)
            .await?;
            Ok(row.get::<i64, _>("count") as usize)
        }
        .boxed()
    }

    fn create_workspace(&self, workspace: MeshWorkspace) -> BoxFuture<'_, Result<MeshWorkspace>> {
        async move {
            let row = sqlx::query("INSERT INTO mesh_workspaces (workspace_id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (workspace_id) DO UPDATE SET name = EXCLUDED.name RETURNING workspace_id, name, created_at")
                .bind(&workspace.workspace_id).bind(&workspace.name).bind(to_pg_i64(workspace.created_at, "created_at")?)
                .fetch_one(&self.pool).await?;
            workspace_from_row(&row)
        }.boxed()
    }

    fn get_workspace(&self, workspace_id: &str) -> BoxFuture<'_, Result<Option<MeshWorkspace>>> {
        let workspace_id = workspace_id.to_string();
        async move {
            let row = sqlx::query("SELECT workspace_id, name, created_at FROM mesh_workspaces WHERE workspace_id = $1")
                .bind(workspace_id).fetch_optional(&self.pool).await?;
            row.as_ref().map(workspace_from_row).transpose()
        }.boxed()
    }

    fn register_node(&self, node: MeshNode) -> BoxFuture<'_, Result<MeshNode>> {
        async move {
            let row = sqlx::query("INSERT INTO mesh_nodes (workspace_id, node_id, display_name, public_key, status, capabilities, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (workspace_id, node_id) DO UPDATE SET display_name = EXCLUDED.display_name, public_key = EXCLUDED.public_key, status = EXCLUDED.status, capabilities = EXCLUDED.capabilities RETURNING workspace_id, node_id, display_name, public_key, status, capabilities, created_at")
                .bind(&node.workspace_id).bind(&node.node_id).bind(&node.display_name).bind(&node.public_key).bind(&node.status).bind(node.capabilities.clone()).bind(to_pg_i64(node.created_at, "created_at")?)
                .fetch_one(&self.pool).await?;
            node_from_row(&row)
        }.boxed()
    }
    fn register_node_with_token(
        &self,
        node: MeshNode,
        token_hash: Option<SecretHash>,
        created_at: u64,
    ) -> BoxFuture<'_, Result<MeshNode>> {
        async move {
            let mut tx = self.pool.begin().await?;
            let row = sqlx::query("INSERT INTO mesh_nodes (workspace_id, node_id, display_name, public_key, status, capabilities, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (workspace_id, node_id) DO UPDATE SET display_name = EXCLUDED.display_name, public_key = EXCLUDED.public_key, status = EXCLUDED.status, capabilities = EXCLUDED.capabilities RETURNING workspace_id, node_id, display_name, public_key, status, capabilities, created_at")
                .bind(&node.workspace_id).bind(&node.node_id).bind(&node.display_name).bind(&node.public_key).bind(&node.status).bind(node.capabilities.clone()).bind(to_pg_i64(node.created_at, "created_at")?)
                .fetch_one(&mut *tx).await?;
            if let Some(token_hash) = token_hash {
                sqlx::query("INSERT INTO mesh_node_tokens (workspace_id, node_id, token_hash, created_at, expires_at, revoked_at) VALUES ($1, $2, $3, $4, NULL, NULL)")
                    .bind(&node.workspace_id).bind(&node.node_id)
                    .bind(stored_token_hash(&token_hash))
                    .bind(to_pg_i64(created_at, "created_at")?)
                    .execute(&mut *tx).await?;
            }
            let node = node_from_row(&row)?;
            tx.commit().await?;
            Ok(node)
        }.boxed()
    }
    fn register_node_with_token_and_audit(
        &self,
        node: MeshNode,
        token_hash: Option<SecretHash>,
        created_at: u64,
        event: MeshEvent,
    ) -> BoxFuture<'_, Result<MeshNode>> {
        async move {
            let mut tx = self.pool.begin().await?;
            let row = sqlx::query("INSERT INTO mesh_nodes (workspace_id,node_id,display_name,public_key,status,capabilities,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id,node_id) DO UPDATE SET display_name=EXCLUDED.display_name,public_key=EXCLUDED.public_key,status=EXCLUDED.status,capabilities=EXCLUDED.capabilities RETURNING workspace_id,node_id,display_name,public_key,status,capabilities,created_at")
                .bind(&node.workspace_id).bind(&node.node_id).bind(&node.display_name).bind(&node.public_key).bind(&node.status).bind(node.capabilities.clone()).bind(to_pg_i64(node.created_at,"created_at")?).fetch_one(&mut *tx).await?;
            if let Some(token_hash) = token_hash {
                sqlx::query("INSERT INTO mesh_node_tokens (workspace_id,node_id,token_hash,created_at,expires_at,revoked_at) VALUES ($1,$2,$3,$4,NULL,NULL)")
                    .bind(&node.workspace_id).bind(&node.node_id).bind(stored_token_hash(&token_hash)).bind(to_pg_i64(created_at,"created_at")?).execute(&mut *tx).await?;
            }
            sqlx::query("INSERT INTO mesh_events (event_id,workspace_id,event_type,payload,created_at) VALUES ($1,$2,$3,$4,$5)")
                .bind(&event.event_id).bind(&event.workspace_id).bind(&event.event_type).bind(event.payload.clone()).bind(to_pg_i64(event.created_at,"created_at")?).execute(&mut *tx).await?;
            let node = node_from_row(&row)?;
            tx.commit().await?;
            Ok(node)
        }.boxed()
    }

    fn get_node(
        &self,
        workspace_id: &str,
        node_id: &str,
    ) -> BoxFuture<'_, Result<Option<MeshNode>>> {
        let workspace_id = workspace_id.to_string();
        let node_id = node_id.to_string();
        async move {
            let row = sqlx::query("SELECT workspace_id, node_id, display_name, public_key, status, capabilities, created_at FROM mesh_nodes WHERE workspace_id = $1 AND node_id = $2")
                .bind(workspace_id).bind(node_id).fetch_optional(&self.pool).await?;
            row.as_ref().map(node_from_row).transpose()
        }.boxed()
    }

    fn heartbeat(&self, presence: MeshPresence) -> BoxFuture<'_, Result<MeshPresence>> {
        async move {
            let row = sqlx::query("INSERT INTO mesh_presence (workspace_id, node_id, online, endpoint_hints, load, updated_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (workspace_id, node_id) DO UPDATE SET online = EXCLUDED.online, endpoint_hints = EXCLUDED.endpoint_hints, load = EXCLUDED.load, updated_at = EXCLUDED.updated_at, expires_at = EXCLUDED.expires_at RETURNING workspace_id, node_id, online, endpoint_hints, load, updated_at, expires_at")
                .bind(&presence.workspace_id).bind(&presence.node_id).bind(presence.online).bind(presence.endpoint_hints.clone()).bind(presence.load.clone()).bind(to_pg_i64(presence.updated_at, "updated_at")?).bind(to_pg_i64(presence.expires_at, "expires_at")?)
                .fetch_one(&self.pool).await?;
            presence_from_row(&row)
        }.boxed()
    }

    fn publish_file_with_quota(
        &self,
        file: MeshFile,
        quota: usize,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshFile>>> {
        async move {
            let mut tx = self.pool.begin().await?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
                .bind(&file.workspace_id)
                .execute(&mut *tx)
                .await?;
            let existing = sqlx::query("SELECT 1 FROM mesh_files WHERE workspace_id = $1 AND file_id = $2")
                .bind(&file.workspace_id).bind(&file.file_id)
                .fetch_optional(&mut *tx).await?.is_some();
            if !existing {
                let current = sqlx::query("SELECT COUNT(*) AS count FROM mesh_files WHERE workspace_id = $1")
                    .bind(&file.workspace_id).fetch_one(&mut *tx).await?.get::<i64, _>("count") as usize;
                if current >= quota {
                    tx.rollback().await?;
                    return Ok(MeshQuotaResult::Exceeded { current, quota });
                }
            }
            let row = sqlx::query("INSERT INTO mesh_files (workspace_id, file_id, name, size_bytes, piece_size, piece_count, manifest, tags, created_by_node_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (workspace_id, file_id) DO UPDATE SET name = EXCLUDED.name, size_bytes = EXCLUDED.size_bytes, piece_size = EXCLUDED.piece_size, piece_count = EXCLUDED.piece_count, manifest = EXCLUDED.manifest, tags = EXCLUDED.tags, created_by_node_id = EXCLUDED.created_by_node_id RETURNING workspace_id, file_id, name, size_bytes, piece_size, piece_count, manifest, tags, created_by_node_id, created_at")
                .bind(&file.workspace_id).bind(&file.file_id).bind(&file.name)
                .bind(to_pg_i64(file.size_bytes, "size_bytes")?).bind(to_pg_i64(file.piece_size, "piece_size")?)
                .bind(to_pg_i64(file.piece_count, "piece_count")?).bind(file.manifest.clone()).bind(file.tags.clone())
                .bind(&file.created_by_node_id).bind(to_pg_i64(file.created_at, "created_at")?)
                .fetch_one(&mut *tx).await?;
            let file = file_from_row(&row)?;
            tx.commit().await?;
            Ok(MeshQuotaResult::Created(file))
        }.boxed()
    }
    fn publish_file_with_availability(
        &self,
        file: MeshFile,
        availability: Option<MeshAvailability>,
        quota: usize,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshFile>>> {
        async move {
            let mut tx = self.pool.begin().await?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
                .bind(&file.workspace_id).execute(&mut *tx).await?;
            let existing = sqlx::query("SELECT 1 FROM mesh_files WHERE workspace_id = $1 AND file_id = $2")
                .bind(&file.workspace_id).bind(&file.file_id).fetch_optional(&mut *tx).await?.is_some();
            if !existing {
                let current = sqlx::query("SELECT COUNT(*) AS count FROM mesh_files WHERE workspace_id = $1")
                    .bind(&file.workspace_id).fetch_one(&mut *tx).await?.get::<i64, _>("count") as usize;
                if current >= quota {
                    tx.rollback().await?;
                    return Ok(MeshQuotaResult::Exceeded { current, quota });
                }
            }
            let row = sqlx::query("INSERT INTO mesh_files (workspace_id, file_id, name, size_bytes, piece_size, piece_count, manifest, tags, created_by_node_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (workspace_id,file_id) DO UPDATE SET name=EXCLUDED.name,size_bytes=EXCLUDED.size_bytes,piece_size=EXCLUDED.piece_size,piece_count=EXCLUDED.piece_count,manifest=EXCLUDED.manifest,tags=EXCLUDED.tags,created_by_node_id=EXCLUDED.created_by_node_id RETURNING workspace_id,file_id,name,size_bytes,piece_size,piece_count,manifest,tags,created_by_node_id,created_at")
                .bind(&file.workspace_id).bind(&file.file_id).bind(&file.name)
                .bind(to_pg_i64(file.size_bytes, "size_bytes")?).bind(to_pg_i64(file.piece_size, "piece_size")?)
                .bind(to_pg_i64(file.piece_count, "piece_count")?).bind(file.manifest.clone()).bind(file.tags.clone())
                .bind(&file.created_by_node_id).bind(to_pg_i64(file.created_at, "created_at")?)
                .fetch_one(&mut *tx).await?;
            if let Some(availability) = availability {
                sqlx::query("INSERT INTO mesh_availability (workspace_id,file_id,node_id,complete,verified_ranges,updated_at,advertise_until) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id,file_id,node_id) DO UPDATE SET complete=EXCLUDED.complete,verified_ranges=EXCLUDED.verified_ranges,updated_at=EXCLUDED.updated_at,advertise_until=EXCLUDED.advertise_until")
                    .bind(&availability.workspace_id).bind(&availability.file_id).bind(&availability.node_id)
                    .bind(availability.complete).bind(availability.verified_ranges.clone())
                    .bind(to_pg_i64(availability.updated_at, "updated_at")?)
                    .bind(availability.advertise_until.map(|v| to_pg_i64(v, "advertise_until")).transpose()?)
                    .execute(&mut *tx).await?;
            }
            let file = file_from_row(&row)?;
            tx.commit().await?;
            Ok(MeshQuotaResult::Created(file))
        }.boxed()
    }
    fn publish_file_with_availability_and_audit(
        &self,
        file: MeshFile,
        availability: Option<MeshAvailability>,
        quota: usize,
        event: MeshEvent,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshFile>>> {
        async move {
            let mut tx = self.pool.begin().await?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))").bind(&file.workspace_id).execute(&mut *tx).await?;
            let existing = sqlx::query("SELECT 1 FROM mesh_files WHERE workspace_id=$1 AND file_id=$2").bind(&file.workspace_id).bind(&file.file_id).fetch_optional(&mut *tx).await?.is_some();
            if !existing {
                let current = sqlx::query("SELECT COUNT(*) AS count FROM mesh_files WHERE workspace_id=$1").bind(&file.workspace_id).fetch_one(&mut *tx).await?.get::<i64,_>("count") as usize;
                if current >= quota { tx.rollback().await?; return Ok(MeshQuotaResult::Exceeded { current, quota }); }
            }
            let row = sqlx::query("INSERT INTO mesh_files (workspace_id,file_id,name,size_bytes,piece_size,piece_count,manifest,tags,created_by_node_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (workspace_id,file_id) DO UPDATE SET name=EXCLUDED.name,size_bytes=EXCLUDED.size_bytes,piece_size=EXCLUDED.piece_size,piece_count=EXCLUDED.piece_count,manifest=EXCLUDED.manifest,tags=EXCLUDED.tags,created_by_node_id=EXCLUDED.created_by_node_id RETURNING workspace_id,file_id,name,size_bytes,piece_size,piece_count,manifest,tags,created_by_node_id,created_at")
                .bind(&file.workspace_id).bind(&file.file_id).bind(&file.name).bind(to_pg_i64(file.size_bytes,"size_bytes")?).bind(to_pg_i64(file.piece_size,"piece_size")?).bind(to_pg_i64(file.piece_count,"piece_count")?).bind(file.manifest.clone()).bind(file.tags.clone()).bind(&file.created_by_node_id).bind(to_pg_i64(file.created_at,"created_at")?).fetch_one(&mut *tx).await?;
            if let Some(a) = availability {
                sqlx::query("INSERT INTO mesh_availability (workspace_id,file_id,node_id,complete,verified_ranges,updated_at,advertise_until) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id,file_id,node_id) DO UPDATE SET complete=EXCLUDED.complete,verified_ranges=EXCLUDED.verified_ranges,updated_at=EXCLUDED.updated_at,advertise_until=EXCLUDED.advertise_until")
                    .bind(&a.workspace_id).bind(&a.file_id).bind(&a.node_id).bind(a.complete).bind(a.verified_ranges.clone()).bind(to_pg_i64(a.updated_at,"updated_at")?).bind(a.advertise_until.map(|v|to_pg_i64(v,"advertise_until")).transpose()?).execute(&mut *tx).await?;
            }
            sqlx::query("INSERT INTO mesh_events (event_id,workspace_id,event_type,payload,created_at) VALUES ($1,$2,$3,$4,$5)").bind(&event.event_id).bind(&event.workspace_id).bind(&event.event_type).bind(event.payload.clone()).bind(to_pg_i64(event.created_at,"created_at")?).execute(&mut *tx).await?;
            let file = file_from_row(&row)?; tx.commit().await?; Ok(MeshQuotaResult::Created(file))
        }.boxed()
    }
    fn create_share_with_quota(
        &self,
        share: MeshShare,
        quota: usize,
        now: u64,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshShare>>> {
        async move {
            let mut tx = self.pool.begin().await?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
                .bind(&share.workspace_id)
                .execute(&mut *tx)
                .await?;
            let row = sqlx::query("INSERT INTO mesh_shares (code, workspace_id, file_id, created_by_node_id, expires_at, revoked_at, capabilities, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (code) DO NOTHING RETURNING code, workspace_id, file_id, created_by_node_id, expires_at, revoked_at, capabilities, created_at")
                .bind(&share.code)
                .bind(&share.workspace_id)
                .bind(&share.file_id)
                .bind(&share.created_by_node_id)
                .bind(to_pg_i64(share.expires_at, "expires_at")?)
                .bind(share.revoked_at.map(|v| to_pg_i64(v, "revoked_at")).transpose()?)
                .bind(share.capabilities.clone())
                .bind(to_pg_i64(share.created_at, "created_at")?)
                .fetch_optional(&mut *tx)
                .await?;
            let Some(row) = row else {
                tx.rollback().await?;
                return Ok(MeshQuotaResult::Conflict);
            };
            let current = sqlx::query("SELECT COUNT(*) AS count FROM mesh_shares WHERE workspace_id = $1 AND revoked_at IS NULL AND expires_at > $2")
                .bind(&share.workspace_id)
                .bind(to_pg_i64(now, "now")?)
                .fetch_one(&mut *tx)
                .await?
                .get::<i64, _>("count") as usize;
            if current > quota {
                tx.rollback().await?;
                return Ok(MeshQuotaResult::Exceeded { current: current - 1, quota });
            }
            let share = share_from_row(&row)?;
            tx.commit().await?;
            Ok(MeshQuotaResult::Created(share))
        }
        .boxed()
    }
    fn create_share_with_quota_and_audit(
        &self,
        share: MeshShare,
        quota: usize,
        now: u64,
        event: MeshEvent,
    ) -> BoxFuture<'_, Result<MeshQuotaResult<MeshShare>>> {
        async move {
            let mut tx = self.pool.begin().await?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))").bind(&share.workspace_id).execute(&mut *tx).await?;
            let row = sqlx::query("INSERT INTO mesh_shares (code,workspace_id,file_id,created_by_node_id,expires_at,revoked_at,capabilities,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (code) DO NOTHING RETURNING code,workspace_id,file_id,created_by_node_id,expires_at,revoked_at,capabilities,created_at").bind(&share.code).bind(&share.workspace_id).bind(&share.file_id).bind(&share.created_by_node_id).bind(to_pg_i64(share.expires_at,"expires_at")?).bind(share.revoked_at.map(|v|to_pg_i64(v,"revoked_at")).transpose()?).bind(share.capabilities.clone()).bind(to_pg_i64(share.created_at,"created_at")?).fetch_optional(&mut *tx).await?;
            let Some(row) = row else { tx.rollback().await?; return Ok(MeshQuotaResult::Conflict); };
            let current = sqlx::query("SELECT COUNT(*) AS count FROM mesh_shares WHERE workspace_id=$1 AND revoked_at IS NULL AND expires_at>$2").bind(&share.workspace_id).bind(to_pg_i64(now,"now")?).fetch_one(&mut *tx).await?.get::<i64,_>("count") as usize;
            if current > quota { tx.rollback().await?; return Ok(MeshQuotaResult::Exceeded { current: current - 1, quota }); }
            sqlx::query("INSERT INTO mesh_events (event_id,workspace_id,event_type,payload,created_at) VALUES ($1,$2,$3,$4,$5)").bind(&event.event_id).bind(&event.workspace_id).bind(&event.event_type).bind(event.payload.clone()).bind(to_pg_i64(event.created_at,"created_at")?).execute(&mut *tx).await?;
            let share = share_from_row(&row)?; tx.commit().await?; Ok(MeshQuotaResult::Created(share))
        }.boxed()
    }

    fn get_file(
        &self,
        workspace_id: &str,
        file_id: &str,
    ) -> BoxFuture<'_, Result<Option<MeshFile>>> {
        let workspace_id = workspace_id.to_string();
        let file_id = file_id.to_string();
        async move {
            let row = sqlx::query("SELECT workspace_id, file_id, name, size_bytes, piece_size, piece_count, manifest, tags, created_by_node_id, created_at FROM mesh_files WHERE workspace_id = $1 AND file_id = $2")
                .bind(workspace_id).bind(file_id).fetch_optional(&self.pool).await?;
            row.as_ref().map(file_from_row).transpose()
        }.boxed()
    }

    fn update_availability(
        &self,
        availability: MeshAvailability,
    ) -> BoxFuture<'_, Result<MeshAvailability>> {
        async move {
            let row = sqlx::query("INSERT INTO mesh_availability (workspace_id, file_id, node_id, complete, verified_ranges, updated_at, advertise_until) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (workspace_id, file_id, node_id) DO UPDATE SET complete = EXCLUDED.complete, verified_ranges = EXCLUDED.verified_ranges, updated_at = EXCLUDED.updated_at, advertise_until = EXCLUDED.advertise_until RETURNING workspace_id, file_id, node_id, complete, verified_ranges, updated_at, advertise_until")
                .bind(&availability.workspace_id).bind(&availability.file_id).bind(&availability.node_id).bind(availability.complete).bind(availability.verified_ranges.clone()).bind(to_pg_i64(availability.updated_at, "updated_at")?).bind(availability.advertise_until.map(|v| to_pg_i64(v, "advertise_until")).transpose()?)
                .fetch_one(&self.pool).await?;
            availability_from_row(&row)
        }.boxed()
    }

    fn resolve_share(&self, code: &str) -> BoxFuture<'_, Result<Option<MeshShare>>> {
        let code = code.to_string();
        async move {
            let row = sqlx::query("SELECT code, workspace_id, file_id, created_by_node_id, expires_at, revoked_at, capabilities, created_at FROM mesh_shares WHERE code = $1")
                .bind(code).fetch_optional(&self.pool).await?;
            row.as_ref().map(share_from_row).transpose()
        }.boxed()
    }

    fn revoke_share(
        &self,
        code: &str,
        revoked_at: u64,
    ) -> BoxFuture<'_, Result<Option<MeshShare>>> {
        let code = code.to_string();
        async move {
            let row = sqlx::query("UPDATE mesh_shares SET revoked_at = $2 WHERE code = $1 RETURNING code, workspace_id, file_id, created_by_node_id, expires_at, revoked_at, capabilities, created_at")
                .bind(code).bind(to_pg_i64(revoked_at, "revoked_at")?).fetch_optional(&self.pool).await?;
            row.as_ref().map(share_from_row).transpose()
        }.boxed()
    }
    fn revoke_share_with_audit(
        &self,
        code: &str,
        revoked_at: u64,
        event: MeshEvent,
    ) -> BoxFuture<'_, Result<Option<MeshShare>>> {
        let code = code.to_string();
        async move {
            let mut tx = self.pool.begin().await?;
            let row = sqlx::query("UPDATE mesh_shares SET revoked_at=$2 WHERE code=$1 RETURNING code,workspace_id,file_id,created_by_node_id,expires_at,revoked_at,capabilities,created_at")
                .bind(&code).bind(to_pg_i64(revoked_at,"revoked_at")?).fetch_optional(&mut *tx).await?;
            let Some(row) = row else { tx.rollback().await?; return Ok(None); };
            sqlx::query("INSERT INTO mesh_events (event_id,workspace_id,event_type,payload,created_at) VALUES ($1,$2,$3,$4,$5)").bind(&event.event_id).bind(&event.workspace_id).bind(&event.event_type).bind(event.payload.clone()).bind(to_pg_i64(event.created_at,"created_at")?).execute(&mut *tx).await?;
            let share = share_from_row(&row)?;
            tx.commit().await?;
            Ok(Some(share))
        }.boxed()
    }

    fn issue_node_token_hash(
        &self,
        workspace_id: &str,
        node_id: &str,
        token_hash: SecretHash,
        created_at: u64,
    ) -> BoxFuture<'_, Result<SecretHash>> {
        let workspace_id = workspace_id.to_string();
        let node_id = node_id.to_string();
        async move {
            sqlx::query("INSERT INTO mesh_node_tokens (workspace_id, node_id, token_hash, created_at, expires_at, revoked_at) VALUES ($1, $2, $3, $4, NULL, NULL)")
                .bind(&workspace_id)
                .bind(&node_id)
                .bind(stored_token_hash(&token_hash))
                .bind(to_pg_i64(created_at, "created_at")?)
                .execute(&self.pool)
                .await?;
            Ok(token_hash)
        }
        .boxed()
    }

    fn get_active_node_token_hash(
        &self,
        workspace_id: &str,
        node_id: &str,
        token_id: &str,
        now: u64,
    ) -> BoxFuture<'_, Result<Option<SecretHash>>> {
        let workspace_id = workspace_id.to_string();
        let node_id = node_id.to_string();
        let token_like = format!("{token_id}:%");
        async move {
            let row = sqlx::query(
                "SELECT token_hash FROM mesh_node_tokens WHERE workspace_id = $1 AND node_id = $2 AND token_hash LIKE $3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $4) ORDER BY created_at DESC LIMIT 1",
            )
            .bind(&workspace_id)
            .bind(&node_id)
            .bind(token_like)
            .bind(to_pg_i64(now, "now")?)
            .fetch_optional(&self.pool)
            .await?;
            row.map(|row| parse_stored_token_hash(row.get::<String, _>("token_hash")))
                .transpose()
        }
        .boxed()
    }

    fn revoke_node_tokens(
        &self,
        workspace_id: &str,
        node_id: &str,
        revoked_at: u64,
    ) -> BoxFuture<'_, Result<u64>> {
        let workspace_id = workspace_id.to_string();
        let node_id = node_id.to_string();
        async move {
            let result = sqlx::query("UPDATE mesh_node_tokens SET revoked_at = $3 WHERE workspace_id = $1 AND node_id = $2 AND revoked_at IS NULL")
                .bind(&workspace_id)
                .bind(&node_id)
                .bind(to_pg_i64(revoked_at, "revoked_at")?)
                .execute(&self.pool)
                .await?;
            Ok(result.rows_affected())
        }
        .boxed()
    }

    fn record_event(&self, event: MeshEvent) -> BoxFuture<'_, Result<MeshEvent>> {
        async move {
            let row = sqlx::query("INSERT INTO mesh_events (event_id, workspace_id, event_type, payload, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO UPDATE SET event_type = EXCLUDED.event_type, payload = EXCLUDED.payload RETURNING event_id, workspace_id, event_type, payload, created_at")
                .bind(&event.event_id).bind(&event.workspace_id).bind(&event.event_type).bind(event.payload.clone()).bind(to_pg_i64(event.created_at, "created_at")?)
                .fetch_one(&self.pool).await?;
            event_from_row(&row)
        }.boxed()
    }
    fn list_candidates(
        &self,
        workspace_id: &str,
        file_id: &str,
        now: u64,
    ) -> BoxFuture<'_, Result<Vec<MeshCandidate>>> {
        let workspace_id = workspace_id.to_string();
        let file_id = file_id.to_string();
        async move {
            let rows = sqlx::query(
                "SELECT a.workspace_id, a.file_id, a.node_id, a.complete, a.verified_ranges, a.updated_at, a.advertise_until, p.online, p.endpoint_hints, p.expires_at AS presence_expires_at \
                 FROM mesh_availability a \
                 JOIN mesh_presence p ON p.workspace_id = a.workspace_id AND p.node_id = a.node_id \
                 WHERE a.workspace_id = $1 AND a.file_id = $2 AND (a.advertise_until IS NULL OR a.advertise_until > $3)",
            )
            .bind(&workspace_id)
            .bind(&file_id)
            .bind(to_pg_i64(now, "now")?)
            .fetch_all(&self.pool)
            .await?;

            rows.iter()
                .map(|row| {
                    let availability = availability_from_row(row)?;
                    let online = row.try_get::<bool, _>("online")?
                        && from_pg_u64(row.try_get("presence_expires_at")?, "presence_expires_at")? > now;
                    Ok(MeshCandidate {
                        availability,
                        online,
                        endpoint_hints: postgres_json(row.try_get("endpoint_hints")?),
                    })
                })
                .collect()
        }
        .boxed()
    }

    fn cleanup_retention(
        &self,
        policy: MeshRetentionPolicy,
        now: u64,
    ) -> BoxFuture<'_, Result<MeshCleanupReport>> {
        async move {
            let share_cutoff = to_pg_i64(now.saturating_sub(policy.expired_share_retention_seconds), "share_cutoff")?;
            let presence_cutoff = to_pg_i64(now.saturating_sub(policy.stale_presence_retention_seconds), "presence_cutoff")?;
            let event_cutoff = to_pg_i64(now.saturating_sub(policy.event_retention_seconds), "event_cutoff")?;
            let now = to_pg_i64(now, "now")?;

            let expired_or_revoked_shares_removed = sqlx::query(
                "DELETE FROM mesh_shares WHERE ((revoked_at IS NULL AND expires_at <= $1) OR revoked_at IS NOT NULL) AND COALESCE(revoked_at, expires_at) < $2",
            )
            .bind(now)
            .bind(share_cutoff)
            .execute(&self.pool)
            .await?
            .rows_affected() as usize;

            let stale_presence_removed = sqlx::query(
                "DELETE FROM mesh_presence WHERE expires_at <= $1 AND expires_at < $2",
            )
            .bind(now)
            .bind(presence_cutoff)
            .execute(&self.pool)
            .await?
            .rows_affected() as usize;

            let old_events_removed = sqlx::query("DELETE FROM mesh_events WHERE created_at < $1")
                .bind(event_cutoff)
                .execute(&self.pool)
                .await?
                .rows_affected() as usize;

            let expired_availability_removed = sqlx::query(
                "DELETE FROM mesh_availability WHERE advertise_until IS NOT NULL AND advertise_until <= $1",
            )
            .bind(now)
            .execute(&self.pool)
            .await?
            .rows_affected() as usize;

            Ok(MeshCleanupReport {
                expired_or_revoked_shares_removed,
                stale_presence_removed,
                old_events_removed,
                expired_availability_removed,
            })
        }
        .boxed()
    }
}

pub async fn repository_from_config(
    config: &Config,
    state: Arc<MeshState>,
) -> Result<Arc<dyn MeshRepository>> {
    config.validate()?;
    match (config.mesh.enabled, config.mesh.storage) {
        (true, MeshStorage::Postgres) => {
            let repository = PostgresMeshRepository::from_config(config)
                .await?
                .expect("mesh postgres repository is present after validation");
            Ok(Arc::new(repository))
        }
        _ => Ok(Arc::new(InMemoryMeshRepository::new(state))),
    }
}
fn list_candidates_from_hot_cache(
    mesh: &MeshState,
    workspace_id: &str,
    file_id: &str,
    now: u64,
) -> Vec<MeshCandidate> {
    mesh.availability
        .iter()
        .filter(|entry| entry.key().0 == workspace_id && entry.key().1 == file_id)
        .filter(|entry| {
            entry
                .advertise_until
                .map(|until| until > now)
                .unwrap_or(true)
        })
        .filter_map(|entry| {
            let node_id = entry.key().2.clone();
            let presence = mesh
                .presence
                .get(&(workspace_id.to_string(), node_id.clone()))?;
            let online = presence.online && presence.expires_at > now;
            Some(MeshCandidate {
                availability: entry.value().clone(),
                online,
                endpoint_hints: presence.endpoint_hints.clone(),
            })
        })
        .collect()
}

pub(crate) fn cleanup_memory_mesh_state(
    mesh: &MeshState,
    policy: MeshRetentionPolicy,
    now: u64,
) -> MeshCleanupReport {
    let mut report = MeshCleanupReport::default();

    let share_cutoff = now.saturating_sub(policy.expired_share_retention_seconds);
    mesh.shares.retain(|_, share| {
        let expired_or_revoked_at = share.revoked_at.unwrap_or(share.expires_at);
        let keep = (share.revoked_at.is_none() && share.expires_at > now)
            || expired_or_revoked_at >= share_cutoff;
        if !keep {
            report.expired_or_revoked_shares_removed += 1;
        }
        keep
    });

    let presence_cutoff = now.saturating_sub(policy.stale_presence_retention_seconds);
    mesh.presence.retain(|_, presence| {
        let keep = presence.expires_at > now || presence.expires_at >= presence_cutoff;
        if !keep {
            report.stale_presence_removed += 1;
        }
        keep
    });

    let event_cutoff = now.saturating_sub(policy.event_retention_seconds);
    mesh.events.retain(|_, event| {
        let keep = event.created_at >= event_cutoff;
        if !keep {
            report.old_events_removed += 1;
        }
        keep
    });

    mesh.availability.retain(|_, availability| {
        let keep = availability
            .advertise_until
            .map(|until| until > now)
            .unwrap_or(true);
        if !keep {
            report.expired_availability_removed += 1;
        }
        keep
    });

    report
}
#[cfg(test)]
mod tests {
    use super::{
        from_pg_u64, postgres_json, to_pg_i64, InMemoryMeshRepository, MeshQuotaResult,
        MeshRepository, MeshState,
    };
    use crate::mesh_domain::MeshShare;
    use serde_json::{json, Value};
    use std::sync::{Arc, Barrier};
    use std::thread;

    #[test]
    fn postgres_numeric_conversion_rejects_overflow_and_negative_values() {
        assert_eq!(to_pg_i64(i64::MAX as u64, "created_at").unwrap(), i64::MAX);
        assert!(to_pg_i64(i64::MAX as u64 + 1, "created_at").is_err());
        assert_eq!(from_pg_u64(0, "created_at").unwrap(), 0);
        assert!(from_pg_u64(-1, "created_at").is_err());
    }

    #[test]
    fn postgres_json_null_defaults_to_object_for_jsonb_defaults() {
        assert_eq!(postgres_json(Value::Null), json!({}));
        assert_eq!(postgres_json(json!([1, 2])), json!([1, 2]));
    }

    #[test]
    fn in_memory_share_codes_are_reserved_globally() {
        for iteration in 0..32 {
            let state = Arc::new(MeshState::default());
            let repository = InMemoryMeshRepository::new(state.clone());
            let barrier = Arc::new(Barrier::new(2));
            let mut handles = Vec::new();

            for workspace_id in ["workspace-a", "workspace-b"] {
                let repository = repository.clone();
                let barrier = barrier.clone();
                let code = format!("same-code-{iteration}");
                handles.push(thread::spawn(move || {
                    barrier.wait();
                    futures::executor::block_on(repository.create_share_with_quota(
                        MeshShare {
                            code,
                            workspace_id: workspace_id.to_string(),
                            file_id: "file".to_string(),
                            created_by_node_id: "node".to_string(),
                            expires_at: 100,
                            revoked_at: None,
                            capabilities: json!({}),
                            created_at: 1,
                        },
                        10,
                        1,
                    ))
                    .expect("share creation")
                }));
            }

            let results = handles
                .into_iter()
                .map(|handle| handle.join().expect("share worker"))
                .collect::<Vec<_>>();
            assert_eq!(
                results
                    .iter()
                    .filter(|result| matches!(result, MeshQuotaResult::Created(_)))
                    .count(),
                1
            );
            assert_eq!(
                results
                    .iter()
                    .filter(|result| matches!(result, MeshQuotaResult::Conflict))
                    .count(),
                1
            );
            assert_eq!(state.shares.len(), 1);
        }
    }
}
