use anyhow::Result;
use axum::{
    extract::ConnectInfo,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json},
    routing::{get, post, put},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::MeshStorage;
use crate::mesh_abuse::{
    abuse_event, redact_mesh_log_value, request_id_from_headers, RateLimitOutcome,
};
use crate::mesh_security::{
    can_workspace, hash_secret, issue_node_token, minimize_public_share_response,
    public_error_body, verify_node_token, Actor, WorkspaceAction,
};
use crate::state::AppState;

pub fn legacy_mesh_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/mesh/health", get(mesh_health))
        .route("/api/mesh/ready", get(mesh_ready))
        .merge(mesh_routes("/api/mesh"))
}

pub fn mesh_api_v1_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/metrics", get(mesh_metrics))
        .merge(mesh_routes("/api/mesh/v1"))
}

fn mesh_routes(prefix: &'static str) -> Router<Arc<AppState>> {
    Router::new()
        .route(&format!("{prefix}/workspaces"), post(create_workspace))
        .route(
            &format!("{prefix}/workspaces/:workspace_id/nodes"),
            post(register_node),
        )
        .route(
            &format!("{prefix}/workspaces/:workspace_id/nodes/:node_id/heartbeat"),
            post(heartbeat),
        )
        .route(
            &format!("{prefix}/workspaces/:workspace_id/files"),
            get(list_files).post(publish_file),
        )
        .route(
            &format!("{prefix}/workspaces/:workspace_id/files/:file_id"),
            get(get_file),
        )
        .route(
            &format!("{prefix}/workspaces/:workspace_id/files/:file_id/availability/:node_id"),
            put(update_availability),
        )
        .route(
            &format!("{prefix}/workspaces/:workspace_id/files/:file_id/candidates"),
            get(candidates),
        )
        .route(
            &format!("{prefix}/workspaces/:workspace_id/events"),
            post(record_event),
        )
        .route(
            &format!("{prefix}/workspaces/:workspace_id/shares"),
            post(create_share),
        )
        .route(
            &format!("{prefix}/shares/:code"),
            get(resolve_share).delete(revoke_share),
        )
        .route(
            &format!("{prefix}/shares/:code/candidates"),
            get(share_candidates),
        )
        .route(
            &format!("{prefix}/shares/:code/events"),
            post(record_share_event),
        )
}
const MAX_MESH_JSON_BYTES: usize = 64 * 1024;

pub use crate::mesh_domain::{
    MeshAvailability, MeshCandidate, MeshCleanupReport, MeshEvent, MeshFile, MeshNode,
    MeshPresence, MeshShare, MeshWorkspace,
};
pub use crate::mesh_repository::{
    repository_from_config, InMemoryMeshRepository, MeshQuotaResult, MeshRepository,
    MeshRetentionPolicy, MeshState, PostgresMeshRepository,
};
const MAX_STORED_ABUSE_EVENTS: usize = 1_024;

impl MeshCandidate {
    fn to_response_json(&self) -> Value {
        json!({
            "nodeId": self.availability.node_id,
            "online": self.online,
            "verifiedRanges": self.availability.verified_ranges,
            "score": if self.online { 1.0 } else { 0.0 },
            "endpointHints": self.endpoint_hints
        })
    }
}

/// Cleans bounded mesh retention in both authoritative storage and the hot cache.
pub async fn cleanup_mesh_retention(state: &AppState, now: u64) -> Result<MeshCleanupReport> {
    let policy = MeshRetentionPolicy {
        expired_share_retention_seconds: state.config.mesh.expired_share_retention_seconds,
        stale_presence_retention_seconds: state.config.mesh.stale_presence_retention_seconds,
        event_retention_seconds: state.config.mesh.event_retention_seconds,
    };
    let repository_report = state.mesh_repository.cleanup_retention(policy, now).await?;
    let hot_cache_report =
        crate::mesh_repository::cleanup_memory_mesh_state(&state.mesh, policy, now);
    Ok(repository_report + hot_cache_report)
}
#[derive(Debug, Deserialize)]
pub struct CreateWorkspaceRequest {
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct RegisterNodeRequest {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    #[serde(default)]
    pub capabilities: Value,
}

#[derive(Debug, Deserialize)]
pub struct HeartbeatRequest {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, rename = "endpointHints")]
    pub endpoint_hints: Value,
    #[serde(default)]
    pub load: Value,
    #[serde(default, rename = "ttlSeconds")]
    pub ttl_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct PublishFileRequest {
    pub manifest: Value,
    #[serde(default)]
    pub availability: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAvailabilityRequest {
    #[serde(default)]
    pub complete: bool,
    #[serde(default, rename = "verifiedRanges")]
    pub verified_ranges: Value,
    #[serde(default, rename = "advertiseUntil")]
    pub advertise_until: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct RecordEventRequest {
    #[serde(rename = "eventType")]
    pub event_type: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
pub struct CreateShareRequest {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(rename = "fileId")]
    pub file_id: String,
    #[serde(default, rename = "createdByNodeId")]
    pub created_by_node_id: Option<String>,
    #[serde(default, rename = "ttlSeconds")]
    pub ttl_seconds: Option<u64>,
    #[serde(default)]
    pub capabilities: Value,
}

#[derive(Debug, Deserialize)]
pub struct ShareEventRequest {
    #[serde(rename = "eventType")]
    pub event_type: String,
    #[serde(default)]
    pub payload: Value,
}
pub async fn mesh_health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    if !state.config.mesh.enabled {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "enabled": false, "status": "disabled", "error": "mesh_disabled" })),
        );
    }
    (
        StatusCode::OK,
        Json(json!({ "enabled": true, "status": "ok" })),
    )
}

pub async fn mesh_ready(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    if !state.config.mesh.enabled {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "enabled": false, "status": "disabled", "error": "mesh_disabled" })),
        );
    }
    (
        StatusCode::OK,
        Json(
            json!({ "enabled": true, "status": "ready", "storage": state.mesh_repository.storage_name() }),
        ),
    )
}

pub async fn mesh_metrics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let enabled = if state.config.mesh.enabled { 1 } else { 0 };
    let active_workspaces = state.mesh.workspaces.len();
    let active_nodes = state.mesh.nodes.len();
    let active_shares = state.mesh.shares.len();
    let online_nodes = state
        .mesh
        .presence
        .iter()
        .filter(|entry| entry.online && entry.expires_at > now_seconds())
        .count();
    let abuse_metrics = state.mesh_metrics.snapshot();

    (
        StatusCode::OK,
        format!(
            "# HELP ponswarp_mesh_enabled Whether the mesh coordinator is enabled.\\n\
             # TYPE ponswarp_mesh_enabled gauge\\n\
             ponswarp_mesh_enabled {enabled}\\n\
             # HELP ponswarp_mesh_active_workspaces In-memory active workspace count.\\n\
             # TYPE ponswarp_mesh_active_workspaces gauge\\n\
             ponswarp_mesh_active_workspaces {active_workspaces}\\n\
             # HELP ponswarp_mesh_active_nodes In-memory registered node count.\\n\
             # TYPE ponswarp_mesh_active_nodes gauge\\n\
             ponswarp_mesh_active_nodes {active_nodes}\\n\
             # HELP ponswarp_mesh_online_nodes In-memory online unexpired node count.\\n\
             # TYPE ponswarp_mesh_online_nodes gauge\\n\
             ponswarp_mesh_online_nodes {online_nodes}\\n\
             # HELP ponswarp_mesh_active_shares In-memory active share count.\\n\
             # TYPE ponswarp_mesh_active_shares gauge\\n\
             ponswarp_mesh_active_shares {active_shares}\\n\
             # HELP ponswarp_mesh_rate_limited_requests Total mesh requests rejected by rate limits.\\n\
             # TYPE ponswarp_mesh_rate_limited_requests counter\\n\
             ponswarp_mesh_rate_limited_requests {}\\n\
             # HELP ponswarp_mesh_quota_rejections Total mesh requests rejected by workspace quotas.\\n\
             # TYPE ponswarp_mesh_quota_rejections counter\\n\
             ponswarp_mesh_quota_rejections {}\\n\
             # HELP ponswarp_mesh_abuse_events Total mesh abuse-defense events recorded.\\n\
             # TYPE ponswarp_mesh_abuse_events counter\\n\
             ponswarp_mesh_abuse_events {}\\n\
             # HELP ponswarp_mesh_request_ids_issued Total mesh request IDs generated server-side.\\n\
             # TYPE ponswarp_mesh_request_ids_issued counter\\n\
             ponswarp_mesh_request_ids_issued {}\\n\
             # HELP ponswarp_mesh_rate_limit_storage_failures Total mesh requests failed closed because limiter storage was unavailable.\\n\
             # TYPE ponswarp_mesh_rate_limit_storage_failures counter\\n\
             ponswarp_mesh_rate_limit_storage_failures {}\\n",
            abuse_metrics.rate_limited_requests,
            abuse_metrics.quota_rejections,
            abuse_metrics.abuse_events,
            abuse_metrics.request_ids_issued,
            abuse_metrics.rate_limit_storage_failures,
        ),
    )
}

pub async fn create_workspace(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateWorkspaceRequest>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) =
        enforce_mesh_rate_limit(&state, "route:create_workspace", &request_id).await
    {
        return limited;
    }
    let workspace_id = req
        .workspace_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("ws_{}", uuid::Uuid::new_v4().simple()));
    if let Some(rejected) = authorize_mesh_action(
        &headers,
        &state,
        &workspace_id,
        WorkspaceAction::ManageWorkspace,
    ) {
        return rejected;
    }
    let workspace = MeshWorkspace {
        workspace_id: workspace_id.clone(),
        name: req.name,
        created_at: now_seconds(),
    };
    let workspace = match state.mesh_repository.create_workspace(workspace).await {
        Ok(workspace) => workspace,
        Err(error) => return repository_error_response(error),
    };
    state
        .mesh
        .workspaces
        .insert(workspace_id.clone(), workspace.clone());
    (
        StatusCode::OK,
        Json(json!({ "workspaceId": workspace_id, "name": workspace.name })),
    )
}

pub async fn register_node(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(workspace_id): Path<String>,
    Json(req): Json<RegisterNodeRequest>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    if let Some(rejected) = authorize_mesh_action(
        &headers,
        &state,
        &workspace_id,
        WorkspaceAction::RegisterNode,
    ) {
        return rejected;
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &format!("route:register_node:workspace:{workspace_id}"),
        &request_id,
    )
    .await
    {
        return limited;
    }
    match workspace_exists_persisted(&state, &workspace_id).await {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "workspace_not_found" })),
            )
        }
        Err(error) => return repository_error_response(error),
    }
    let status = if state.config.mesh.auto_approve_nodes {
        "approved"
    } else {
        "pending"
    }
    .to_string();
    let node = MeshNode {
        workspace_id: workspace_id.clone(),
        node_id: req.node_id.clone(),
        display_name: req.display_name,
        public_key: req.public_key,
        status: status.clone(),
        capabilities: req.capabilities,
        created_at: now_seconds(),
    };
    let now = now_seconds();
    let (issued_token, token_hash) = if state.config.mesh.storage == MeshStorage::Postgres {
        match issue_node_token(&workspace_id, &req.node_id, &state.config.mesh.token_pepper) {
            Ok((token, token_hash)) => (Some(token), Some(token_hash)),
            Err(error) => return repository_error_response(error),
        }
    } else {
        (None, None)
    };
    let token_id = token_hash.as_ref().map(|hash| hash.id.clone());
    let audit_event = MeshEvent {
        event_id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.clone(),
        event_type: "node_token_issued".to_string(),
        payload: json!({ "nodeId": req.node_id, "tokenId": token_id }),
        created_at: now,
    };
    let node = match state
        .mesh_repository
        .register_node_with_token_and_audit(node, token_hash, now, audit_event)
        .await
    {
        Ok(node) => node,
        Err(error) => return repository_error_response(error),
    };
    state
        .mesh
        .nodes
        .insert((workspace_id, req.node_id.clone()), node);
    let mut response = json!({ "nodeId": req.node_id, "status": status });
    if let Some(token) = issued_token {
        response["nodeToken"] = json!(token);
    }
    (StatusCode::OK, Json(response))
}

pub async fn heartbeat(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path((workspace_id, node_id)): Path<(String, String)>,
    Json(req): Json<HeartbeatRequest>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    if let Some(rejected) =
        authorize_node_owned_action(&headers, &state, &workspace_id, &node_id, "heartbeat").await
    {
        return rejected;
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &format!("route:heartbeat:workspace:{workspace_id}:node:{node_id}"),
        &request_id,
    )
    .await
    {
        return limited;
    }
    match node_exists_persisted(&state, &workspace_id, &node_id).await {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "node_not_found" })),
            )
        }
        Err(error) => return repository_error_response(error),
    }
    let now = now_seconds();
    let ttl = req
        .ttl_seconds
        .unwrap_or(state.config.mesh.presence_ttl_seconds)
        .max(1);
    let presence = MeshPresence {
        workspace_id: workspace_id.clone(),
        node_id: node_id.clone(),
        online: req.status.as_deref().unwrap_or("online") == "online",
        endpoint_hints: req.endpoint_hints,
        load: req.load,
        updated_at: now,
        expires_at: now + ttl,
    };
    let presence = match state.mesh_repository.heartbeat(presence).await {
        Ok(presence) => presence,
        Err(error) => return repository_error_response(error),
    };
    state
        .mesh
        .presence
        .insert((workspace_id, node_id.clone()), presence.clone());
    (
        StatusCode::OK,
        Json(
            json!({ "nodeId": node_id, "online": presence.online, "expiresAt": presence.expires_at }),
        ),
    )
}

pub async fn publish_file(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(workspace_id): Path<String>,
    Json(req): Json<PublishFileRequest>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    let actor = match authorize_workspace_or_node_action(
        &headers,
        &state,
        &workspace_id,
        WorkspaceAction::PublishFile,
        "publish_file",
    )
    .await
    {
        Ok(actor) => actor,
        Err(rejected) => return rejected,
    };
    match workspace_exists_persisted(&state, &workspace_id).await {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "workspace_not_found" })),
            )
        }
        Err(error) => return repository_error_response(error),
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &authenticated_mesh_rate_limit_subject(&workspace_id, "publish_file", &actor),
        &request_id,
    )
    .await
    {
        return limited;
    }
    let manifest = req.manifest;
    if json_size(&manifest) > MAX_MESH_JSON_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": "manifest_too_large" })),
        );
    }
    let requested_availability = req.availability;
    let availability_node_id = requested_availability
        .as_ref()
        .and_then(|value| string_field(value, "nodeId"));
    if let Actor::Node { node_id, .. } = &actor {
        if availability_node_id.as_deref() != Some(node_id.as_str()) {
            record_auth_denied(
                &state,
                &workspace_id,
                "publish_file",
                json!({ "reason": "node_boundary", "nodeId": node_id }),
            )
            .await;
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "mesh_forbidden" })),
            );
        }
    }
    if let Some(node_id) = availability_node_id.as_deref() {
        match node_exists_persisted(&state, &workspace_id, node_id).await {
            Ok(true) => {}
            Ok(false) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "node_not_found" })),
                )
            }
            Err(error) => return repository_error_response(error),
        }
    }
    let file_id = string_field(&manifest, "fileId")
        .unwrap_or_else(|| format!("file_{}", uuid::Uuid::new_v4().simple()));
    let file = MeshFile {
        workspace_id: workspace_id.clone(),
        file_id: file_id.clone(),
        name: string_field(&manifest, "name").unwrap_or_else(|| file_id.clone()),
        size_bytes: u64_field(&manifest, "sizeBytes")
            .or_else(|| u64_field(&manifest, "size"))
            .unwrap_or(0),
        piece_size: u64_field(&manifest, "pieceSize").unwrap_or(0),
        piece_count: u64_field(&manifest, "pieceCount").unwrap_or(0),
        created_by_node_id: availability_node_id.clone().unwrap_or_default(),
        manifest,
        tags: Value::Array(vec![]),
        created_at: now_seconds(),
    };
    let initial_availability = availability_node_id
        .clone()
        .zip(requested_availability.as_ref())
        .map(|(node_id, availability)| MeshAvailability {
            workspace_id: workspace_id.clone(),
            file_id: file_id.clone(),
            node_id,
            complete: availability
                .get("complete")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            verified_ranges: availability
                .get("verifiedRanges")
                .cloned()
                .unwrap_or(Value::Array(vec![])),
            updated_at: file.created_at,
            advertise_until: None,
        });
    let file = match state
        .mesh_repository
        .publish_file_with_availability_and_audit(
            file.clone(),
            initial_availability.clone(),
            state.config.mesh.workspace_file_quota,
            MeshEvent {
                event_id: uuid::Uuid::new_v4().to_string(),
                workspace_id: workspace_id.clone(),
                event_type: "file_published".to_string(),
                payload: json!({ "fileId": file_id, "createdByNodeId": file.created_by_node_id }),
                created_at: file.created_at,
            },
        )
        .await
    {
        Ok(crate::mesh_repository::MeshQuotaResult::Created(file)) => file,
        Ok(crate::mesh_repository::MeshQuotaResult::Exceeded { current, quota }) => {
            return enforce_workspace_quota(
                &state,
                &workspace_id,
                &request_id,
                &format!("mesh:{workspace_id}:publish_file"),
                "files",
                current,
                quota,
            )
            .unwrap();
        }
        Ok(crate::mesh_repository::MeshQuotaResult::Conflict) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({ "error": "file_id_conflict" })),
            );
        }
        Err(error) => return repository_error_response(error),
    };
    state
        .mesh
        .files
        .insert((workspace_id.clone(), file_id.clone()), file.clone());
    if let Some(availability) = initial_availability {
        state.mesh.availability.insert(
            (
                availability.workspace_id.clone(),
                availability.file_id.clone(),
                availability.node_id.clone(),
            ),
            availability,
        );
    }
    (
        StatusCode::OK,
        Json(json!({ "fileId": file_id, "name": file.name, "sizeBytes": file.size_bytes })),
    )
}

pub async fn list_files(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(workspace_id): Path<String>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    if let Some(rejected) = authorize_mesh_action(
        &headers,
        &state,
        &workspace_id,
        WorkspaceAction::ReadMetadata,
    ) {
        return rejected;
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &format!("route:list_files:workspace:{workspace_id}"),
        &request_id,
    )
    .await
    {
        return limited;
    }
    match workspace_exists_persisted(&state, &workspace_id).await {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "workspace_not_found" })),
            )
        }
        Err(error) => return repository_error_response(error),
    }
    let files = match state.mesh_repository.list_files(&workspace_id).await {
        Ok(files) => files,
        Err(error) => return repository_error_response(error),
    };
    let mut file_responses = Vec::with_capacity(files.len());
    for file in &files {
        let online_providers = match state
            .mesh_repository
            .online_provider_count(&workspace_id, &file.file_id, now_seconds())
            .await
        {
            Ok(count) => count,
            Err(error) => return repository_error_response(error),
        };
        file_responses.push(json!({
            "fileId": file.file_id,
            "name": file.name,
            "sizeBytes": file.size_bytes,
            "pieceCount": file.piece_count,
            "onlineProviders": online_providers
        }));
    }
    let files = file_responses;
    (
        StatusCode::OK,
        Json(json!({ "workspaceId": workspace_id, "files": files })),
    )
}

pub async fn get_file(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path((workspace_id, file_id)): Path<(String, String)>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    if let Some(rejected) = authorize_mesh_action(
        &headers,
        &state,
        &workspace_id,
        WorkspaceAction::ReadMetadata,
    ) {
        return rejected;
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &format!("route:get_file:workspace:{workspace_id}"),
        &request_id,
    )
    .await
    {
        return limited;
    }
    let Some(file) = (match get_file_persisted(&state, &workspace_id, &file_id).await {
        Ok(file) => file,
        Err(error) => return repository_error_response(error),
    }) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "file_not_found" })),
        );
    };
    (
        StatusCode::OK,
        Json(
            json!({ "fileId": file.file_id, "name": file.name, "sizeBytes": file.size_bytes, "pieceCount": file.piece_count }),
        ),
    )
}

pub async fn update_availability(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path((workspace_id, file_id, node_id)): Path<(String, String, String)>,
    Json(req): Json<UpdateAvailabilityRequest>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    if let Some(rejected) = authorize_node_owned_action(
        &headers,
        &state,
        &workspace_id,
        &node_id,
        "update_availability",
    )
    .await
    {
        return rejected;
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &format!("route:update_availability:workspace:{workspace_id}:node:{node_id}"),
        &request_id,
    )
    .await
    {
        return limited;
    }
    match node_exists_persisted(&state, &workspace_id, &node_id).await {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "node_not_found" })),
            )
        }
        Err(error) => return repository_error_response(error),
    }
    match get_file_persisted(&state, &workspace_id, &file_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "file_not_found" })),
            )
        }
        Err(error) => return repository_error_response(error),
    }
    let availability = MeshAvailability {
        workspace_id: workspace_id.clone(),
        file_id: file_id.clone(),
        node_id: node_id.clone(),
        complete: req.complete,
        verified_ranges: req.verified_ranges,
        updated_at: now_seconds(),
        advertise_until: req.advertise_until,
    };
    let availability = match state
        .mesh_repository
        .update_availability(availability)
        .await
    {
        Ok(availability) => availability,
        Err(error) => return repository_error_response(error),
    };
    state
        .mesh
        .availability
        .insert((workspace_id, file_id, node_id.clone()), availability);
    (
        StatusCode::OK,
        Json(json!({ "nodeId": node_id, "updated": true })),
    )
}

pub async fn candidates(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path((workspace_id, file_id)): Path<(String, String)>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    if let Some(rejected) = authorize_mesh_action(
        &headers,
        &state,
        &workspace_id,
        WorkspaceAction::ReadMetadata,
    ) {
        return rejected;
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &format!("route:candidates:workspace:{workspace_id}"),
        &request_id,
    )
    .await
    {
        return limited;
    }
    match get_file_persisted(&state, &workspace_id, &file_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "file_not_found" })),
            )
        }
        Err(error) => return repository_error_response(error),
    }
    let now = now_seconds();
    let providers = match state
        .mesh_repository
        .list_candidates(&workspace_id, &file_id, now)
        .await
    {
        Ok(providers) => providers,
        Err(error) => return repository_error_response(error),
    };
    for candidate in &providers {
        state.mesh.availability.insert(
            (
                candidate.availability.workspace_id.clone(),
                candidate.availability.file_id.clone(),
                candidate.availability.node_id.clone(),
            ),
            candidate.availability.clone(),
        );
    }
    let providers: Vec<_> = providers
        .iter()
        .map(MeshCandidate::to_response_json)
        .collect();
    (
        StatusCode::OK,
        Json(json!({ "fileId": file_id, "providers": providers })),
    )
}

pub async fn record_event(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(workspace_id): Path<String>,
    Json(req): Json<RecordEventRequest>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    if let Some(rejected) = authorize_mesh_action(
        &headers,
        &state,
        &workspace_id,
        WorkspaceAction::ManageWorkspace,
    ) {
        return rejected;
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &format!("route:event:workspace:{workspace_id}"),
        &request_id,
    )
    .await
    {
        return limited;
    }
    match workspace_exists_persisted(&state, &workspace_id).await {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "workspace_not_found" })),
            )
        }
        Err(error) => return repository_error_response(error),
    }
    if json_size(&req.payload) > MAX_MESH_JSON_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": "event_too_large" })),
        );
    }
    let event_id = uuid::Uuid::new_v4().to_string();
    let event = MeshEvent {
        event_id: event_id.clone(),
        workspace_id,
        event_type: req.event_type,
        payload: req.payload,
        created_at: now_seconds(),
    };
    let event = match state.mesh_repository.record_event(event).await {
        Ok(event) => event,
        Err(error) => return repository_error_response(error),
    };
    state.mesh.events.insert(event_id.clone(), event);
    (StatusCode::OK, Json(json!({ "eventId": event_id })))
}

pub async fn create_share(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(workspace_id): Path<String>,
    Json(req): Json<CreateShareRequest>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    let actor = match authorize_workspace_or_node_action(
        &headers,
        &state,
        &workspace_id,
        WorkspaceAction::CreateShare,
        "create_share",
    )
    .await
    {
        Ok(actor) => actor,
        Err(rejected) => return rejected,
    };
    match workspace_exists_persisted(&state, &workspace_id).await {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "workspace_not_found" })),
            )
        }
        Err(error) => return repository_error_response(error),
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &authenticated_mesh_rate_limit_subject(&workspace_id, "create_share", &actor),
        &request_id,
    )
    .await
    {
        return limited;
    }
    let existing_file = match get_file_persisted(&state, &workspace_id, &req.file_id).await {
        Ok(Some(file)) => file,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "file_not_found" })),
            )
        }
        Err(error) => return repository_error_response(error),
    };
    let mut created_by_node_id = req.created_by_node_id.unwrap_or_default();
    if let Actor::Node { node_id, .. } = &actor {
        if !created_by_node_id.is_empty() && created_by_node_id != *node_id {
            record_auth_denied(
                &state,
                &workspace_id,
                "create_share",
                json!({ "reason": "node_boundary", "nodeId": node_id }),
            )
            .await;
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "mesh_forbidden" })),
            );
        }
        if created_by_node_id.is_empty() {
            created_by_node_id = node_id.clone();
        }
        if existing_file.created_by_node_id != *node_id {
            record_auth_denied(
                &state,
                &workspace_id,
                "create_share",
                json!({ "reason": "file_boundary", "nodeId": node_id }),
            )
            .await;
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "mesh_forbidden" })),
            );
        }
    }
    if !created_by_node_id.is_empty() {
        match node_exists_persisted(&state, &workspace_id, &created_by_node_id).await {
            Ok(true) => {}
            Ok(false) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "node_not_found" })),
                )
            }
            Err(error) => return repository_error_response(error),
        }
    }
    if json_size(&req.capabilities) > MAX_MESH_JSON_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": "share_too_large" })),
        );
    }
    let now = now_seconds();
    let requested_code = req.code.filter(|value| !value.trim().is_empty());
    let generated_code = requested_code.is_none();
    let mut created_share = None;
    for _ in 0..5 {
        let share = MeshShare {
            code: requested_code.clone().unwrap_or_else(generate_share_code),
            workspace_id: workspace_id.clone(),
            file_id: req.file_id.clone(),
            created_by_node_id: created_by_node_id.clone(),
            expires_at: now + req.ttl_seconds.unwrap_or(86_400).max(1),
            revoked_at: None,
            capabilities: req.capabilities.clone(),
            created_at: now,
        };
        match state
            .mesh_repository
            .create_share_with_quota_and_audit(
                share,
                state.config.mesh.workspace_share_quota,
                now,
                MeshEvent {
                    event_id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: workspace_id.clone(),
                    event_type: "share_created".to_string(),
                    payload: json!({ "fileId": req.file_id, "createdByNodeId": created_by_node_id }),
                    created_at: now,
                },
            )
            .await
        {
            Ok(crate::mesh_repository::MeshQuotaResult::Created(share)) => {
                created_share = Some(share);
                break;
            }
            Ok(crate::mesh_repository::MeshQuotaResult::Conflict) if generated_code => continue,
            Ok(crate::mesh_repository::MeshQuotaResult::Conflict) => {
                return (
                    StatusCode::CONFLICT,
                    Json(json!({ "error": "share_code_conflict" })),
                );
            }
            Ok(crate::mesh_repository::MeshQuotaResult::Exceeded { current, quota }) => {
                return enforce_workspace_quota(
                    &state,
                    &workspace_id,
                    &request_id,
                    &format!("mesh:{workspace_id}:create_share"),
                    "shares",
                    current,
                    quota,
                )
                .unwrap();
            }
            Err(error) => return repository_error_response(error),
        }
    }
    let share = match created_share {
        Some(share) => share,
        None => {
            return (
                StatusCode::CONFLICT,
                Json(json!({ "error": "share_code_unavailable" })),
            );
        }
    };
    let code = share.code.clone();
    state.mesh.shares.insert(code.clone(), share.clone());
    (
        StatusCode::OK,
        Json(json!({
            "code": code,
            "workspaceId": workspace_id,
            "fileId": share.file_id,
            "createdByNodeId": share.created_by_node_id,
            "expiresAt": share.expires_at,
            "revokedAt": share.revoked_at,
            "capabilities": share.capabilities
        })),
    )
}

pub async fn resolve_share(
    headers: HeaderMap,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &public_share_rate_limit_subject(peer, "resolve_share"),
        &request_id,
    )
    .await
    {
        return limited;
    }
    let Some(share) = (match state.mesh_repository.resolve_share(&code).await {
        Ok(share) => share,
        Err(error) => return repository_error_response(error),
    }) else {
        return (StatusCode::NOT_FOUND, Json(public_error_body()));
    };
    state.mesh.shares.insert(code.clone(), share.clone());
    if share.revoked_at.is_some() {
        return (StatusCode::NOT_FOUND, Json(public_error_body()));
    }
    let now = now_seconds();
    if share.expires_at <= now {
        return (StatusCode::NOT_FOUND, Json(public_error_body()));
    }
    let Some(file) = (match get_file_persisted(&state, &share.workspace_id, &share.file_id).await {
        Ok(file) => file,
        Err(error) => return repository_error_response(error),
    }) else {
        return (StatusCode::NOT_FOUND, Json(public_error_body()));
    };
    let summary = minimize_public_share_response(&share, &file);
    let Ok(summary_value) = serde_json::to_value(summary) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "share_summary_serialization_failed" })),
        );
    };
    if let Err(error) = record_mesh_audit_event(
        &state,
        &share.workspace_id,
        "share_resolved",
        json!({ "fileId": share.file_id }),
    )
    .await
    {
        return repository_error_response(error);
    }
    (StatusCode::OK, Json(summary_value))
}

pub async fn revoke_share(
    headers: HeaderMap,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &public_share_rate_limit_subject(peer, "revoke_share"),
        &request_id,
    )
    .await
    {
        return limited;
    }
    let Some(existing_share) = (match state.mesh_repository.resolve_share(&code).await {
        Ok(share) => share,
        Err(error) => return repository_error_response(error),
    }) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "share_not_found" })),
        );
    };
    let actor = match authorize_workspace_or_node_action(
        &headers,
        &state,
        &existing_share.workspace_id,
        WorkspaceAction::CreateShare,
        "revoke_share",
    )
    .await
    {
        Ok(actor) => actor,
        Err(rejected) => return rejected,
    };
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &authenticated_mesh_rate_limit_subject(
            &existing_share.workspace_id,
            "revoke_share",
            &actor,
        ),
        &request_id,
    )
    .await
    {
        return limited;
    }
    if let Actor::Node { node_id, .. } = &actor {
        if existing_share.created_by_node_id != *node_id {
            record_auth_denied(
                &state,
                &existing_share.workspace_id,
                "revoke_share",
                json!({ "reason": "node_boundary", "nodeId": node_id }),
            )
            .await;
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "mesh_forbidden" })),
            );
        }
    }
    let now = now_seconds();
    let audit_event = MeshEvent {
        event_id: uuid::Uuid::new_v4().to_string(),
        workspace_id: existing_share.workspace_id.clone(),
        event_type: "share_revoked".to_string(),
        payload: json!({ "fileId": existing_share.file_id, "createdByNodeId": existing_share.created_by_node_id }),
        created_at: now,
    };
    let Some(share) = (match state
        .mesh_repository
        .revoke_share_with_audit(&code, now, audit_event)
        .await
    {
        Ok(share) => share,
        Err(error) => return repository_error_response(error),
    }) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "share_not_found" })),
        );
    };
    state.mesh.shares.insert(code.clone(), share);
    (
        StatusCode::OK,
        Json(json!({ "code": code, "revokedAt": now })),
    )
}

pub async fn share_candidates(
    headers: HeaderMap,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &public_share_rate_limit_subject(peer, "share_candidates"),
        &request_id,
    )
    .await
    {
        return limited;
    }
    let Some(share) = (match active_share_persisted(&state, &code).await {
        Ok(share) => share,
        Err(error) => return repository_error_response(error),
    }) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "share_not_found_or_inactive" })),
        );
    };
    let now = now_seconds();
    let providers = match state
        .mesh_repository
        .list_candidates(&share.workspace_id, &share.file_id, now)
        .await
    {
        Ok(providers) => providers,
        Err(error) => return repository_error_response(error),
    };
    for candidate in &providers {
        state.mesh.availability.insert(
            (
                candidate.availability.workspace_id.clone(),
                candidate.availability.file_id.clone(),
                candidate.availability.node_id.clone(),
            ),
            candidate.availability.clone(),
        );
    }
    let providers: Vec<_> = providers
        .iter()
        .map(MeshCandidate::to_response_json)
        .collect();
    (
        StatusCode::OK,
        Json(json!({ "code": code, "fileId": share.file_id, "providers": providers })),
    )
}

pub async fn record_share_event(
    headers: HeaderMap,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
    Json(req): Json<ShareEventRequest>,
) -> impl IntoResponse {
    if let Some(disabled) = mesh_disabled_response(&state) {
        return disabled;
    }
    let request_id = request_id_from_headers(&headers, &state.mesh_metrics);
    if let Some(limited) = enforce_mesh_rate_limit(
        &state,
        &public_share_rate_limit_subject(peer, "share_event"),
        &request_id,
    )
    .await
    {
        return limited;
    }
    let Some(share) = (match active_share_persisted(&state, &code).await {
        Ok(share) => share,
        Err(error) => return repository_error_response(error),
    }) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "share_not_found_or_inactive" })),
        );
    };
    if json_size(&req.payload) > MAX_MESH_JSON_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": "event_too_large" })),
        );
    }
    let event_id = uuid::Uuid::new_v4().to_string();
    let event = MeshEvent {
        event_id: event_id.clone(),
        workspace_id: share.workspace_id,
        event_type: req.event_type,
        payload: share_event_payload(req.payload),
        created_at: now_seconds(),
    };
    let event = match state.mesh_repository.record_event(event).await {
        Ok(event) => event,
        Err(error) => return repository_error_response(error),
    };
    state.mesh.events.insert(event_id.clone(), event);
    (StatusCode::OK, Json(json!({ "eventId": event_id })))
}

fn authorize_mesh_action(
    headers: &HeaderMap,
    state: &AppState,
    workspace_id: &str,
    action: WorkspaceAction,
) -> Option<(StatusCode, Json<Value>)> {
    if state.config.mesh.storage != MeshStorage::Postgres {
        return None;
    }

    let Some(header) = headers.get(axum::http::header::AUTHORIZATION) else {
        return Some((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "mesh_auth_required" })),
        ));
    };
    let Ok(value) = header.to_str() else {
        return Some((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "mesh_auth_required" })),
        ));
    };
    let Some(token) = value.strip_prefix("Bearer ").map(str::trim) else {
        return Some((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "mesh_auth_required" })),
        ));
    };

    // G002 hardening foundation: Postgres-backed coordinator requires an operator/admin
    // bearer secret before mutating or reading workspace-scoped metadata. This keeps
    // the private-beta API fail-closed until full user/session membership is wired.
    if token != state.config.mesh.admin_token {
        return Some((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "mesh_forbidden" })),
        ));
    }

    let actor = Actor::Admin {
        user_id: "mesh-operator".to_string(),
    };
    if can_workspace(&actor, workspace_id, None, action) {
        None
    } else {
        Some((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "mesh_forbidden" })),
        ))
    }
}

async fn authorize_node_owned_action(
    headers: &HeaderMap,
    state: &AppState,
    workspace_id: &str,
    node_id: &str,
    flow: &str,
) -> Option<(StatusCode, Json<Value>)> {
    match authorize_workspace_or_node_action(
        headers,
        state,
        workspace_id,
        WorkspaceAction::PublishFile,
        flow,
    )
    .await
    {
        Ok(Actor::Node {
            node_id: actor_node_id,
            ..
        }) if actor_node_id != node_id => {
            record_auth_denied(
                state,
                workspace_id,
                flow,
                json!({ "reason": "node_boundary", "nodeId": actor_node_id }),
            )
            .await;
            Some((
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "mesh_forbidden" })),
            ))
        }
        Ok(_) => None,
        Err(response) => Some(response),
    }
}

fn authenticated_mesh_rate_limit_subject(workspace_id: &str, route: &str, actor: &Actor) -> String {
    let identity = match actor {
        Actor::Anonymous { ip_hash } => format!("anonymous:{ip_hash}"),
        Actor::User {
            user_id,
            session_id,
        } => format!("user:{user_id}:session:{session_id}"),
        Actor::Admin { user_id } => format!("admin:{user_id}"),
        Actor::Node {
            node_id, token_id, ..
        } => format!("node:{node_id}:token:{token_id}"),
    };
    format!("route:{route}:workspace:{workspace_id}:actor:{identity}")
}

async fn authorize_workspace_or_node_action(
    headers: &HeaderMap,
    state: &AppState,
    workspace_id: &str,
    action: WorkspaceAction,
    flow: &str,
) -> Result<Actor, (StatusCode, Json<Value>)> {
    if state.config.mesh.storage != MeshStorage::Postgres {
        return Ok(Actor::Admin {
            user_id: "mesh-dev".to_string(),
        });
    }

    let Some(token) = bearer_token(headers) else {
        record_auth_denied(
            state,
            workspace_id,
            flow,
            json!({ "reason": "missing_bearer" }),
        )
        .await;
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "mesh_auth_required" })),
        ));
    };

    if token == state.config.mesh.admin_token {
        let actor = Actor::Admin {
            user_id: "mesh-operator".to_string(),
        };
        return can_workspace(&actor, workspace_id, None, action)
            .then_some(actor)
            .ok_or_else(|| {
                (
                    StatusCode::FORBIDDEN,
                    Json(json!({ "error": "mesh_forbidden" })),
                )
            });
    }

    let Some(node_id) = node_id_from_headers(headers) else {
        record_auth_denied(
            state,
            workspace_id,
            flow,
            json!({ "reason": "missing_node_id" }),
        )
        .await;
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "mesh_forbidden" })),
        ));
    };

    let token_id = match hash_secret(
        &token,
        &state.config.mesh.token_pepper,
        &crate::mesh_security::node_token_context(workspace_id, &node_id),
    ) {
        Ok(hash) => hash.id,
        Err(_) => {
            record_auth_denied(
                state,
                workspace_id,
                flow,
                json!({ "reason": "invalid_token_hash" }),
            )
            .await;
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "mesh_forbidden" })),
            ));
        }
    };

    let expected = match state
        .mesh_repository
        .get_active_node_token_hash(workspace_id, &node_id, &token_id, now_seconds())
        .await
    {
        Ok(Some(expected)) => expected,
        Ok(None) => {
            record_auth_denied(
                state,
                workspace_id,
                flow,
                json!({ "reason": "token_not_found", "nodeId": node_id }),
            )
            .await;
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "mesh_forbidden" })),
            ));
        }
        Err(_) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "mesh_repository_error" })),
            ));
        }
    };

    if !verify_node_token(
        &token,
        workspace_id,
        &node_id,
        &state.config.mesh.token_pepper,
        &expected,
    ) {
        record_auth_denied(
            state,
            workspace_id,
            flow,
            json!({ "reason": "wrong_token", "nodeId": node_id }),
        )
        .await;
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "mesh_forbidden" })),
        ));
    }
    let Some(node) = (match state.mesh_repository.get_node(workspace_id, &node_id).await {
        Ok(node) => node,
        Err(_) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "mesh_repository_error" })),
            ));
        }
    }) else {
        record_auth_denied(
            state,
            workspace_id,
            flow,
            json!({ "reason": "node_not_found", "nodeId": node_id }),
        )
        .await;
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "mesh_forbidden" })),
        ));
    };
    if !matches!(node.status.as_str(), "approved" | "active") {
        record_auth_denied(
            state,
            workspace_id,
            flow,
            json!({ "reason": "node_not_approved", "nodeId": node_id }),
        )
        .await;
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "mesh_forbidden" })),
        ));
    }

    let actor = Actor::Node {
        workspace_id: workspace_id.to_string(),
        node_id,
        token_id,
    };
    can_workspace(&actor, workspace_id, None, action)
        .then_some(actor)
        .ok_or_else(|| {
            (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "mesh_forbidden" })),
            )
        })
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
}

fn node_id_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-ponswarp-node-id")
        .or_else(|| headers.get("x-mesh-node-id"))?
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|node_id| !node_id.is_empty())
        .map(ToOwned::to_owned)
}

async fn record_auth_denied(state: &AppState, workspace_id: &str, flow: &str, payload: Value) {
    if let Err(error) = record_mesh_audit_event(
        state,
        workspace_id,
        "auth_denied",
        json!({ "flow": flow, "details": redact_mesh_log_value(&payload) }),
    )
    .await
    {
        tracing::error!(
            workspace_id = %workspace_id,
            flow = %flow,
            error = %error,
            "failed to persist mesh authorization denial audit event"
        );
    }
}

async fn record_mesh_audit_event(
    state: &AppState,
    workspace_id: &str,
    event_type: &str,
    payload: Value,
) -> Result<()> {
    let event_id = uuid::Uuid::new_v4().to_string();
    let event = MeshEvent {
        event_id: event_id.clone(),
        workspace_id: workspace_id.to_string(),
        event_type: event_type.to_string(),
        payload: redact_mesh_log_value(&payload),
        created_at: now_seconds(),
    };
    let event = state.mesh_repository.record_event(event).await?;
    state.mesh.events.insert(event_id, event);
    Ok(())
}
fn mesh_disabled_response(state: &AppState) -> Option<(StatusCode, Json<Value>)> {
    if !state.config.mesh.enabled {
        return Some((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "mesh_disabled" })),
        ));
    }

    None
}

async fn workspace_exists_persisted(state: &AppState, workspace_id: &str) -> Result<bool> {
    if state.mesh.workspaces.contains_key(workspace_id) {
        return Ok(true);
    }
    if let Some(workspace) = state.mesh_repository.get_workspace(workspace_id).await? {
        state
            .mesh
            .workspaces
            .insert(workspace.workspace_id.clone(), workspace);
        return Ok(true);
    }
    Ok(false)
}

async fn node_exists_persisted(
    state: &AppState,
    workspace_id: &str,
    node_id: &str,
) -> Result<bool> {
    if node_exists(state, workspace_id, node_id) {
        return Ok(true);
    }
    if let Some(node) = state
        .mesh_repository
        .get_node(workspace_id, node_id)
        .await?
    {
        state
            .mesh
            .nodes
            .insert((node.workspace_id.clone(), node.node_id.clone()), node);
        return Ok(true);
    }
    Ok(false)
}

async fn get_file_persisted(
    state: &AppState,
    workspace_id: &str,
    file_id: &str,
) -> Result<Option<MeshFile>> {
    if state.config.mesh.storage != MeshStorage::Postgres {
        if let Some(file) = state
            .mesh
            .files
            .get(&(workspace_id.to_string(), file_id.to_string()))
        {
            return Ok(Some(file.clone()));
        }
    }
    let file = state
        .mesh_repository
        .get_file(workspace_id, file_id)
        .await?;
    if let Some(file) = &file {
        state.mesh.files.insert(
            (file.workspace_id.clone(), file.file_id.clone()),
            file.clone(),
        );
    } else if state.config.mesh.storage == MeshStorage::Postgres {
        state
            .mesh
            .files
            .remove(&(workspace_id.to_string(), file_id.to_string()));
    }
    Ok(file)
}

async fn active_share_persisted(state: &AppState, code: &str) -> Result<Option<MeshShare>> {
    let Some(share) = state.mesh_repository.resolve_share(code).await? else {
        return Ok(None);
    };
    if share.revoked_at.is_some() || share.expires_at <= now_seconds() {
        return Ok(None);
    }
    state.mesh.shares.insert(share.code.clone(), share.clone());
    Ok(Some(share))
}

fn repository_error_response(error: anyhow::Error) -> (StatusCode, Json<Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "mesh_repository_error", "message": error.to_string() })),
    )
}

fn node_exists(state: &AppState, workspace_id: &str, node_id: &str) -> bool {
    state
        .mesh
        .nodes
        .contains_key(&(workspace_id.to_string(), node_id.to_string()))
}

fn json_size(value: &Value) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

#[cfg(test)]
fn count_online_providers(state: &AppState, workspace_id: &str, file_id: &str) -> usize {
    let now = now_seconds();
    state
        .mesh
        .availability
        .iter()
        .filter(|entry| entry.key().0 == workspace_id && entry.key().1 == file_id)
        .filter(|entry| {
            state
                .mesh
                .presence
                .get(&(workspace_id.to_string(), entry.key().2.clone()))
                .is_some_and(|presence| presence.online && presence.expires_at > now)
        })
        .count()
}
#[cfg(test)]
fn active_share(state: &AppState, code: &str) -> Option<MeshShare> {
    let share = state.mesh.shares.get(code)?.clone();
    if share.revoked_at.is_some() || share.expires_at <= now_seconds() {
        return None;
    }
    Some(share)
}

fn generate_share_code() -> String {
    let raw = uuid::Uuid::new_v4().simple().to_string();
    format!(
        "{}-{}",
        &raw[0..4].to_uppercase(),
        &raw[4..8].to_uppercase()
    )
}

fn redacted_route_group(subject: &str) -> String {
    subject.split(':').take(2).collect::<Vec<_>>().join(":")
}

fn share_rate_limit_key(code: &str) -> String {
    let digest = Sha256::digest(code.as_bytes());
    format!("share:{:x}", digest)
}
fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}
async fn enforce_mesh_rate_limit(
    state: &AppState,
    subject: &str,
    request_id: &str,
) -> Option<(StatusCode, Json<Value>)> {
    match state.mesh_rate_limiter.check(subject, now_seconds()).await {
        RateLimitOutcome::Allowed { .. } => None,
        RateLimitOutcome::Limited {
            limit,
            remaining,
            retry_after_seconds,
            reset_seconds,
        } => {
            state.mesh_metrics.record_rate_limited();
            record_abuse_marker(
                state,
                "mesh.rate_limited",
                request_id,
                &redacted_route_group(subject),
                "rate_limit_exceeded",
                json!({
                    "routeGroup": redacted_route_group(subject),
                    "retryAfterSeconds": retry_after_seconds,
                    "rateLimit": {
                        "limit": limit,
                        "remaining": remaining,
                        "resetSeconds": reset_seconds
                    }
                }),
            );
            Some((
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "error": "rate_limited",
                    "requestId": request_id,
                    "retryAfterSeconds": retry_after_seconds,
                    "rateLimit": {
                        "limit": limit,
                        "remaining": remaining,
                        "resetSeconds": reset_seconds
                    }
                })),
            ))
        }
        RateLimitOutcome::StorageUnavailable {
            limit,
            retry_after_seconds,
        } => {
            state.mesh_metrics.record_rate_limit_storage_failure();
            record_abuse_marker(
                state,
                "mesh.rate_limit_storage_unavailable",
                request_id,
                &redacted_route_group(subject),
                "rate_limit_storage_unavailable",
                json!({
                    "routeGroup": redacted_route_group(subject),
                    "retryAfterSeconds": retry_after_seconds,
                    "rateLimit": {
                        "limit": limit,
                        "remaining": 0
                    }
                }),
            );
            Some((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "error": "rate_limit_storage_unavailable",
                    "requestId": request_id,
                    "retryAfterSeconds": retry_after_seconds,
                    "rateLimit": {
                        "limit": limit,
                        "remaining": 0
                    }
                })),
            ))
        }
    }
}

fn public_share_rate_limit_subject(peer: std::net::SocketAddr, route: &str) -> String {
    format!(
        "route:{route}:client:{}",
        share_rate_limit_key(&peer.ip().to_string())
    )
}

fn enforce_workspace_quota(
    state: &AppState,
    workspace_id: &str,
    request_id: &str,
    subject: &str,
    resource: &str,
    current: usize,
    quota: usize,
) -> Option<(StatusCode, Json<Value>)> {
    if current < quota {
        return None;
    }
    state.mesh_metrics.record_quota_rejection();
    record_abuse_marker(
        state,
        "mesh.quota_rejected",
        request_id,
        subject,
        "workspace_quota_exceeded",
        json!({ "workspaceId": workspace_id, "resource": resource, "current": current, "quota": quota }),
    );
    Some((
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "error": "quota_exceeded",
            "requestId": request_id,
            "resource": resource,
            "quota": quota
        })),
    ))
}

fn share_event_payload(payload: Value) -> Value {
    json!({ "shareCode": "[REDACTED]", "payload": redact_mesh_log_value(&payload) })
}

fn record_abuse_marker(
    state: &AppState,
    event_type: &str,
    request_id: &str,
    subject: &str,
    reason: &str,
    details: Value,
) {
    if stored_abuse_event_count(state) >= MAX_STORED_ABUSE_EVENTS {
        return;
    }

    let event_id = uuid::Uuid::new_v4().to_string();
    state.mesh.events.insert(
        event_id.clone(),
        MeshEvent {
            event_id,
            workspace_id: "abuse".to_string(),
            event_type: event_type.to_string(),
            payload: abuse_event(event_type, request_id, subject, reason, details),
            created_at: now_seconds(),
        },
    );
}

fn stored_abuse_event_count(state: &AppState) -> usize {
    state
        .mesh
        .events
        .iter()
        .filter(|entry| entry.workspace_id == "abuse")
        .count()
}

#[cfg(test)]
fn workspace_quota_lock(state: &AppState, workspace_id: &str) -> Arc<Mutex<()>> {
    state
        .mesh
        .quota_locks
        .entry(workspace_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[cfg(test)]
fn workspace_file_count(state: &AppState, workspace_id: &str) -> usize {
    state
        .mesh
        .files
        .iter()
        .filter(|entry| entry.key().0 == workspace_id)
        .count()
}

#[cfg(test)]
fn workspace_share_count(state: &AppState, workspace_id: &str) -> usize {
    let now = now_seconds();
    state
        .mesh
        .shares
        .iter()
        .filter(|entry| {
            entry.workspace_id == workspace_id
                && entry.revoked_at.is_none()
                && entry.expires_at > now
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, MeshConfig, MeshStorage};

    #[test]
    fn mesh_config_defaults_disabled() {
        let config = Config::from_env_with_mesh(MeshConfig::default());
        assert!(!config.mesh.enabled);
    }
    #[tokio::test]
    async fn cleanup_removes_expired_and_revoked_shares_after_retention() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.expired_share_retention_seconds = 30;
        let state = AppState::new_for_test_with_config(config);
        let now = 1_000;

        state.mesh.shares.insert(
            "EXPIRED".into(),
            MeshShare {
                code: "EXPIRED".into(),
                workspace_id: "ws".into(),
                file_id: "file".into(),
                created_by_node_id: "node".into(),
                expires_at: now - 31,
                revoked_at: None,
                capabilities: json!([]),
                created_at: now - 120,
            },
        );
        state.mesh.shares.insert(
            "REVOKED".into(),
            MeshShare {
                code: "REVOKED".into(),
                workspace_id: "ws".into(),
                file_id: "file".into(),
                created_by_node_id: "node".into(),
                expires_at: now + 600,
                revoked_at: Some(now - 31),
                capabilities: json!([]),
                created_at: now - 120,
            },
        );

        let report = cleanup_mesh_retention(&state, now).await.expect("cleanup");

        assert_eq!(report.expired_or_revoked_shares_removed, 2);
        assert!(!state.mesh.shares.contains_key("EXPIRED"));
        assert!(!state.mesh.shares.contains_key("REVOKED"));
    }

    #[tokio::test]
    async fn cleanup_removes_stale_presence_after_retention() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.stale_presence_retention_seconds = 60;
        let state = AppState::new_for_test_with_config(config);
        let now = 1_000;

        state.mesh.presence.insert(
            ("ws".into(), "within-retention".into()),
            MeshPresence {
                workspace_id: "ws".into(),
                node_id: "within-retention".into(),
                online: true,
                endpoint_hints: json!([]),
                load: json!({}),
                updated_at: now - 600,
                expires_at: now - 1,
            },
        );
        state.mesh.presence.insert(
            ("ws".into(), "at-cutoff".into()),
            MeshPresence {
                workspace_id: "ws".into(),
                node_id: "at-cutoff".into(),
                online: true,
                endpoint_hints: json!([]),
                load: json!({}),
                updated_at: now - 600,
                expires_at: now - 60,
            },
        );
        state.mesh.presence.insert(
            ("ws".into(), "beyond-retention".into()),
            MeshPresence {
                workspace_id: "ws".into(),
                node_id: "beyond-retention".into(),
                online: true,
                endpoint_hints: json!([]),
                load: json!({}),
                updated_at: now - 600,
                expires_at: now - 61,
            },
        );

        let report = cleanup_mesh_retention(&state, now).await.expect("cleanup");

        assert_eq!(report.stale_presence_removed, 1);
        assert!(state
            .mesh
            .presence
            .contains_key(&(String::from("ws"), String::from("within-retention"),)));
        assert!(state
            .mesh
            .presence
            .contains_key(&(String::from("ws"), String::from("at-cutoff"),)));
        assert!(!state
            .mesh
            .presence
            .contains_key(&(String::from("ws"), String::from("beyond-retention"),)));
    }

    #[tokio::test]
    async fn cleanup_removes_events_older_than_retention() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.event_retention_seconds = 300;
        let state = AppState::new_for_test_with_config(config);
        let now = 1_000;

        state.mesh.events.insert(
            "old".into(),
            MeshEvent {
                event_id: "old".into(),
                workspace_id: "ws".into(),
                event_type: "mesh.test".into(),
                payload: json!({}),
                created_at: now - 301,
            },
        );
        state.mesh.events.insert(
            "new".into(),
            MeshEvent {
                event_id: "new".into(),
                workspace_id: "ws".into(),
                event_type: "mesh.test".into(),
                payload: json!({}),
                created_at: now - 300,
            },
        );

        let report = cleanup_mesh_retention(&state, now).await.expect("cleanup");

        assert_eq!(report.old_events_removed, 1);
        assert!(!state.mesh.events.contains_key("old"));
        assert!(state.mesh.events.contains_key("new"));
    }

    #[tokio::test]
    async fn cleanup_keeps_non_expired_records_and_removes_expired_availability() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.expired_share_retention_seconds = 30;
        config.mesh.stale_presence_retention_seconds = 60;
        config.mesh.event_retention_seconds = 300;
        let state = AppState::new_for_test_with_config(config);
        let now = 1_000;

        state.mesh.shares.insert(
            "LIVE".into(),
            MeshShare {
                code: "LIVE".into(),
                workspace_id: "ws".into(),
                file_id: "file".into(),
                created_by_node_id: "node".into(),
                expires_at: now + 1,
                revoked_at: None,
                capabilities: json!([]),
                created_at: now - 120,
            },
        );
        state.mesh.presence.insert(
            ("ws".into(), "node".into()),
            MeshPresence {
                workspace_id: "ws".into(),
                node_id: "node".into(),
                online: true,
                endpoint_hints: json!([]),
                load: json!({}),
                updated_at: now,
                expires_at: now + 60,
            },
        );
        state.mesh.events.insert(
            "recent".into(),
            MeshEvent {
                event_id: "recent".into(),
                workspace_id: "ws".into(),
                event_type: "mesh.test".into(),
                payload: json!({}),
                created_at: now - 1,
            },
        );
        state.mesh.availability.insert(
            ("ws".into(), "file".into(), "expired".into()),
            MeshAvailability {
                workspace_id: "ws".into(),
                file_id: "file".into(),
                node_id: "expired".into(),
                complete: true,
                verified_ranges: json!([]),
                updated_at: now - 10,
                advertise_until: Some(now),
            },
        );
        state.mesh.availability.insert(
            ("ws".into(), "file".into(), "live".into()),
            MeshAvailability {
                workspace_id: "ws".into(),
                file_id: "file".into(),
                node_id: "live".into(),
                complete: true,
                verified_ranges: json!([]),
                updated_at: now - 10,
                advertise_until: Some(now + 1),
            },
        );

        let report = cleanup_mesh_retention(&state, now).await.expect("cleanup");

        assert_eq!(report.expired_or_revoked_shares_removed, 0);
        assert_eq!(report.stale_presence_removed, 0);
        assert_eq!(report.old_events_removed, 0);
        assert_eq!(report.expired_availability_removed, 1);
        assert!(state.mesh.shares.contains_key("LIVE"));
        assert!(state
            .mesh
            .presence
            .contains_key(&(String::from("ws"), String::from("node"))));
        assert!(state.mesh.events.contains_key("recent"));
        assert!(!state.mesh.availability.contains_key(&(
            String::from("ws"),
            String::from("file"),
            String::from("expired"),
        )));
        assert!(state.mesh.availability.contains_key(&(
            String::from("ws"),
            String::from("file"),
            String::from("live"),
        )));
    }

    #[tokio::test]
    async fn cleanup_postgres_mode_still_cleans_hot_cache() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.storage = MeshStorage::Postgres;
        config.mesh.stale_presence_retention_seconds = 10;
        let state = AppState::new_for_test_with_config(config);
        state.mesh.presence.insert(
            ("ws".into(), "node".into()),
            MeshPresence {
                workspace_id: "ws".into(),
                node_id: "node".into(),
                online: false,
                endpoint_hints: json!({}),
                load: json!({}),
                updated_at: 1,
                expires_at: 1,
            },
        );

        let report = cleanup_mesh_retention(&state, 1_000)
            .await
            .expect("cleanup");

        assert_eq!(report.stale_presence_removed, 1);
        assert!(!state
            .mesh
            .presence
            .contains_key(&(String::from("ws"), String::from("node"))));
    }

    #[test]
    fn create_workspace_request_accepts_explicit_workspace_id() {
        let req: CreateWorkspaceRequest =
            serde_json::from_value(json!({ "workspaceId": "ws_cli", "name": "CLI Workspace" }))
                .expect("valid workspace request");
        assert_eq!(req.workspace_id.as_deref(), Some("ws_cli"));
        assert_eq!(req.name, "CLI Workspace");
    }

    #[test]
    fn create_share_request_accepts_optional_code_and_ttl() {
        let req: CreateShareRequest = serde_json::from_value(json!({
            "code": "ABCD-1234",
            "fileId": "file",
            "createdByNodeId": "node",
            "ttlSeconds": 120,
            "capabilities": ["grid", "resume"]
        }))
        .expect("valid share request");
        assert_eq!(req.code.as_deref(), Some("ABCD-1234"));
        assert_eq!(req.file_id, "file");
        assert_eq!(req.created_by_node_id.as_deref(), Some("node"));
        assert_eq!(req.ttl_seconds, Some(120));
    }

    #[test]
    fn active_share_excludes_revoked_and_expired_shares() {
        let state = AppState::new_for_test_with_mesh(true);
        let now = now_seconds();
        state.mesh.shares.insert(
            "OKAY-0001".into(),
            MeshShare {
                code: "OKAY-0001".into(),
                workspace_id: "ws".into(),
                file_id: "file".into(),
                created_by_node_id: "node".into(),
                expires_at: now + 60,
                revoked_at: None,
                capabilities: json!([]),
                created_at: now,
            },
        );
        state.mesh.shares.insert(
            "OLD-0001".into(),
            MeshShare {
                code: "OLD-0001".into(),
                workspace_id: "ws".into(),
                file_id: "file".into(),
                created_by_node_id: "node".into(),
                expires_at: now.saturating_sub(1),
                revoked_at: None,
                capabilities: json!([]),
                created_at: now,
            },
        );
        state.mesh.shares.insert(
            "NOPE-0001".into(),
            MeshShare {
                code: "NOPE-0001".into(),
                workspace_id: "ws".into(),
                file_id: "file".into(),
                created_by_node_id: "node".into(),
                expires_at: now + 60,
                revoked_at: Some(now),
                capabilities: json!([]),
                created_at: now,
            },
        );

        assert_eq!(
            active_share(&state, "OKAY-0001").map(|share| share.code),
            Some("OKAY-0001".into())
        );
        assert!(active_share(&state, "OLD-0001").is_none());
        assert!(active_share(&state, "NOPE-0001").is_none());
        state.mesh.shares.insert(
            "EDGE-0001".into(),
            MeshShare {
                code: "EDGE-0001".into(),
                workspace_id: "ws".into(),
                file_id: "file".into(),
                created_by_node_id: "node".into(),
                expires_at: now,
                revoked_at: None,
                capabilities: json!([]),
                created_at: now,
            },
        );
        assert!(active_share(&state, "EDGE-0001").is_none());
    }

    #[test]
    fn generated_share_codes_are_short_human_codes() {
        let code = generate_share_code();
        assert_eq!(code.len(), 9);
        assert_eq!(code.as_bytes()[4], b'-');
        assert!(code.chars().all(|ch| ch == '-' || ch.is_ascii_hexdigit()));
    }

    #[test]
    fn mesh_state_counts_only_online_unexpired_providers() {
        let state = AppState::new_for_test_with_mesh(true);
        state.mesh.availability.insert(
            ("ws".into(), "file".into(), "node".into()),
            MeshAvailability {
                workspace_id: "ws".into(),
                file_id: "file".into(),
                node_id: "node".into(),
                complete: true,
                verified_ranges: json!([[0, 1]]),
                updated_at: now_seconds(),
                advertise_until: None,
            },
        );
        state.mesh.presence.insert(
            ("ws".into(), "node".into()),
            MeshPresence {
                workspace_id: "ws".into(),
                node_id: "node".into(),
                online: true,
                endpoint_hints: json!([]),
                load: json!({}),
                updated_at: now_seconds(),
                expires_at: now_seconds() + 60,
            },
        );
        assert_eq!(count_online_providers(&state, "ws", "file"), 1);
        state.mesh.availability.insert(
            ("ws".into(), "file".into(), "edge".into()),
            MeshAvailability {
                workspace_id: "ws".into(),
                file_id: "file".into(),
                node_id: "edge".into(),
                complete: true,
                verified_ranges: json!([[0, 1]]),
                updated_at: now_seconds(),
                advertise_until: None,
            },
        );
        state.mesh.presence.insert(
            ("ws".into(), "edge".into()),
            MeshPresence {
                workspace_id: "ws".into(),
                node_id: "edge".into(),
                online: true,
                endpoint_hints: json!([]),
                load: json!({}),
                updated_at: now_seconds(),
                expires_at: now_seconds(),
            },
        );
        assert_eq!(count_online_providers(&state, "ws", "file"), 1);
    }
    #[test]
    fn workspace_quota_records_abuse_event_without_leaking_share_code() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.workspace_share_quota = 1;
        let state = AppState::new_for_test_with_config(config);
        let now = now_seconds();
        state.mesh.shares.insert(
            "RAW-CODE".into(),
            MeshShare {
                code: "RAW-CODE".into(),
                workspace_id: "ws".into(),
                file_id: "file".into(),
                created_by_node_id: "node".into(),
                expires_at: now + 60,
                revoked_at: None,
                capabilities: json!({ "shareCode": "RAW-CODE", "safe": true }),
                created_at: now,
            },
        );

        let response = enforce_workspace_quota(
            &state,
            "ws",
            "req-test",
            "mesh:ws:create_share",
            "shares",
            workspace_share_count(&state, "ws"),
            state.config.mesh.workspace_share_quota,
        )
        .expect("quota should reject at configured limit");

        assert_eq!(response.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(state.mesh_metrics.snapshot().quota_rejections, 1);
        let stored = state
            .mesh
            .events
            .iter()
            .find(|entry| entry.event_type == "mesh.quota_rejected")
            .expect("abuse event stored");
        let event_text = serde_json::to_string(&stored.payload).expect("event serializes");
        assert!(event_text.contains("req-test"));
        assert!(!event_text.contains("RAW-CODE"));
    }

    #[test]
    fn share_event_payload_redacts_route_code_and_sensitive_payload_fields() {
        let payload = share_event_payload(json!({
            "shareCode": "RAW-CODE",
            "nested": { "authorization": "Bearer raw", "safe": "kept" }
        }));

        let event_text = serde_json::to_string(&payload).expect("payload serializes");
        assert!(!event_text.contains("RAW-CODE"));
        assert!(!event_text.contains("Bearer raw"));
        assert!(event_text.contains("[REDACTED]"));
        assert!(event_text.contains("kept"));
    }

    #[test]
    fn abuse_marker_caps_stored_events() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        let state = AppState::new_for_test_with_config(config);

        for idx in 0..(MAX_STORED_ABUSE_EVENTS + 25) {
            record_abuse_marker(
                &state,
                "mesh.rate_limited",
                &format!("req-{idx}"),
                "subject",
                "rate_limit_exceeded",
                json!({ "attempt": idx }),
            );
        }

        assert_eq!(stored_abuse_event_count(&state), MAX_STORED_ABUSE_EVENTS);
    }

    #[tokio::test]
    async fn public_share_rate_limit_is_client_scoped_not_share_code_scoped_and_redacted() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.rate_limit_capacity = 1;
        config.mesh.rate_limit_refill_per_second = 1;
        let state = AppState::new_for_test_with_config(config);
        let peer: std::net::SocketAddr = "203.0.113.10:41000".parse().unwrap();
        let subject = public_share_rate_limit_subject(peer, "resolve_share");

        assert!(enforce_mesh_rate_limit(&state, &subject, "req-rate")
            .await
            .is_none());
        let rotated_code_same_client = public_share_rate_limit_subject(peer, "resolve_share");
        let response = enforce_mesh_rate_limit(&state, &rotated_code_same_client, "req-rate")
            .await
            .expect("second request from the same client should be limited");
        assert_eq!(response.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.1["error"], "rate_limited");
        assert_eq!(response.1["requestId"], "req-rate");
        assert_eq!(response.1["rateLimit"]["limit"], 1);
        assert_eq!(response.1["rateLimit"]["remaining"], 0);

        let other_peer: std::net::SocketAddr = "203.0.113.20:42000".parse().unwrap();
        assert!(
            enforce_mesh_rate_limit(
                &state,
                &public_share_rate_limit_subject(other_peer, "resolve_share"),
                "req-other",
            )
            .await
            .is_none(),
            "different client bucket should not be limited"
        );

        let stored = state
            .mesh
            .events
            .iter()
            .find(|entry| entry.event_type == "mesh.rate_limited")
            .expect("rate-limit telemetry stored");
        let event_text = serde_json::to_string(&stored.payload).expect("event serializes");
        assert!(event_text.contains("route:resolve_share"));
        assert!(!event_text.contains("203.0.113.10"));
    }

    #[test]
    fn workspace_quota_lock_serializes_file_quota_check_and_insert() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.workspace_file_quota = 1;
        let state = AppState::new_for_test_with_config(config);
        let workspace_id = "ws";

        {
            let quota_lock = workspace_quota_lock(&state, workspace_id);
            let _quota_guard = quota_lock.lock().expect("workspace quota lock");
            assert!(enforce_workspace_quota(
                &state,
                workspace_id,
                "req-a",
                "mesh:ws:publish_file",
                "files",
                workspace_file_count(&state, workspace_id),
                state.config.mesh.workspace_file_quota,
            )
            .is_none());
            state.mesh.files.insert(
                (workspace_id.to_string(), "file-a".to_string()),
                MeshFile {
                    workspace_id: workspace_id.to_string(),
                    file_id: "file-a".to_string(),
                    name: "file-a".to_string(),
                    size_bytes: 1,
                    piece_size: 1,
                    piece_count: 1,
                    created_by_node_id: "node".to_string(),
                    manifest: json!({ "fileId": "file-a" }),
                    tags: json!([]),
                    created_at: now_seconds(),
                },
            );
        }

        let quota_lock = workspace_quota_lock(&state, workspace_id);
        let _quota_guard = quota_lock.lock().expect("workspace quota lock");
        assert!(enforce_workspace_quota(
            &state,
            workspace_id,
            "req-b",
            "mesh:ws:publish_file",
            "files",
            workspace_file_count(&state, workspace_id),
            state.config.mesh.workspace_file_quota,
        )
        .is_some());
    }

    #[tokio::test]
    async fn mesh_rate_limit_records_metric_and_request_id() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.rate_limit_capacity = 1;
        config.mesh.rate_limit_refill_per_second = 1;
        let state = AppState::new_for_test_with_config(config);
        let headers = HeaderMap::new();
        let request_id = request_id_from_headers(&headers, &state.mesh_metrics);

        assert!(enforce_mesh_rate_limit(&state, "subject", &request_id)
            .await
            .is_none());
        let limited = enforce_mesh_rate_limit(&state, "subject", &request_id)
            .await
            .expect("second request is limited");

        assert_eq!(limited.0, StatusCode::TOO_MANY_REQUESTS);
        let metrics = state.mesh_metrics.snapshot();
        assert_eq!(metrics.rate_limited_requests, 1);
        assert_eq!(metrics.abuse_events, 1);
        assert_eq!(metrics.request_ids_issued, 1);
    }

    #[tokio::test]
    async fn in_memory_repository_persists_workspace_and_share_in_mesh_state() {
        let state = Arc::new(MeshState::default());
        let repository = InMemoryMeshRepository::new(state.clone());
        let now = now_seconds();

        let workspace = repository
            .create_workspace(MeshWorkspace {
                workspace_id: "ws_repo".into(),
                name: "Repository Workspace".into(),
                created_at: now,
            })
            .await
            .expect("workspace stored");

        assert_eq!(workspace.workspace_id, "ws_repo");
        assert!(state.workspaces.contains_key("ws_repo"));
        assert_eq!(
            repository
                .get_workspace("ws_repo")
                .await
                .expect("workspace read")
                .map(|workspace| workspace.name),
            Some("Repository Workspace".into())
        );

        repository
            .create_share_with_quota(
                MeshShare {
                    code: "REPO-0001".into(),
                    workspace_id: "ws_repo".into(),
                    file_id: "file".into(),
                    created_by_node_id: "node".into(),
                    expires_at: now + 60,
                    revoked_at: None,
                    capabilities: json!({ "read": true }),
                    created_at: now,
                },
                10,
                now,
            )
            .await
            .expect("share stored");

        assert_eq!(
            repository
                .resolve_share("REPO-0001")
                .await
                .expect("share read")
                .map(|share| share.file_id),
            Some("file".into())
        );
    }

    #[tokio::test]
    async fn disabled_mesh_postgres_storage_uses_memory_repository_without_database() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = false;
        config.mesh.storage = MeshStorage::Postgres;
        let repository = repository_from_config(&config, Arc::new(MeshState::default()))
            .await
            .expect("disabled mesh does not require db");

        assert_eq!(repository.storage_name(), "memory");
    }

    #[tokio::test]
    async fn enabled_postgres_mesh_repository_fails_fast_without_database_url() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.storage = MeshStorage::Postgres;
        let err = match repository_from_config(&config, Arc::new(MeshState::default())).await {
            Ok(_) => panic!("postgres storage without database url must fail"),
            Err(err) => err.to_string(),
        };

        assert!(err.contains("DATABASE_URL"));
    }

    #[tokio::test]
    async fn node_token_validation_enforces_own_node_boundary_and_audits_denial() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.storage = MeshStorage::Postgres;
        config.mesh.token_pepper = "test-pepper-that-is-long-enough-32-bytes".to_string();
        let state = AppState::new_for_test_with_config(config);
        state
            .mesh_repository
            .register_node(MeshNode {
                workspace_id: "ws".to_string(),
                node_id: "node-a".to_string(),
                display_name: "Node A".to_string(),
                public_key: "test-public-key".to_string(),
                status: "approved".to_string(),
                capabilities: json!({}),
                created_at: 1,
            })
            .await
            .expect("store approved node");

        let (token, token_hash) =
            issue_node_token("ws", "node-a", &state.config.mesh.token_pepper).expect("token");
        state
            .mesh_repository
            .issue_node_token_hash("ws", "node-a", token_hash.clone(), 1)
            .await
            .expect("store token hash");

        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().expect("auth header"),
        );
        headers.insert("x-ponswarp-node-id", "node-a".parse().expect("node header"));

        assert!(
            authorize_node_owned_action(&headers, &state, "ws", "node-a", "heartbeat")
                .await
                .is_none()
        );
        assert!(
            authorize_node_owned_action(&headers, &state, "ws", "node-b", "heartbeat")
                .await
                .is_some()
        );

        let denied = state
            .mesh
            .events
            .iter()
            .find(|entry| entry.event_type == "auth_denied")
            .expect("auth denied audit event");
        let event_text = serde_json::to_string(&denied.payload).expect("event serializes");
        assert!(event_text.contains("node_boundary"));
        assert!(!event_text.contains(&token));
        assert!(!event_text.contains(&token_hash.hash));
    }

    #[tokio::test]
    async fn wrong_node_token_is_denied_without_raw_token_exposure() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.storage = MeshStorage::Postgres;
        config.mesh.token_pepper = "test-pepper-that-is-long-enough-32-bytes".to_string();
        let state = AppState::new_for_test_with_config(config);
        let (token, token_hash) =
            issue_node_token("ws", "node-a", &state.config.mesh.token_pepper).expect("token");
        state
            .mesh_repository
            .issue_node_token_hash("ws", "node-a", token_hash, 1)
            .await
            .expect("store token hash");

        let wrong_token = format!("{token}-wrong");
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {wrong_token}")
                .parse()
                .expect("auth header"),
        );
        headers.insert("x-ponswarp-node-id", "node-a".parse().expect("node header"));

        let rejected = authorize_node_owned_action(&headers, &state, "ws", "node-a", "heartbeat")
            .await
            .expect("wrong token rejected");
        assert_eq!(rejected.0, StatusCode::FORBIDDEN);

        let all_events = state
            .mesh
            .events
            .iter()
            .map(|entry| serde_json::to_string(&entry.payload).expect("event serializes"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!all_events.contains(&token));
        assert!(!all_events.contains(&wrong_token));
    }
    #[test]
    fn postgres_storage_request_path_is_not_disabled_by_storage_mode() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.storage = MeshStorage::Postgres;
        config.database.url = "postgres://example.invalid/ponswarp".to_string();
        let state = AppState::new_for_test_with_config(config);

        assert!(mesh_disabled_response(&state).is_none());
    }
}
