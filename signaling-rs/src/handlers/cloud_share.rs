//! Cloudflare R2 backed temporary file sharing handlers.

use crate::billing::{CheckoutProvider, PaymentProviderStatus};
use crate::config::CloudConfig;
use crate::state::{AppState, CloudStorage};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

type HmacSha256 = Hmac<sha2::Sha256>;

const MULTIPART_UPLOAD_THRESHOLD_BYTES: u64 = 512 * 1024 * 1024;
const MULTIPART_UPLOAD_PART_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MULTIPART_PARTS: u64 = 10_000;
const CLOUD_SHARE_CODE_LEN: usize = 10;
const CLOUD_SHARE_CODE_ALPHABET: &[u8] = b"23456789abcdefghjkmnpqrstuvwxyz";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCloudShareRequest {
    pub root_name: String,
    pub files: Vec<CreateCloudFileRequest>,
    pub entitlement_token: Option<String>,
    pub retention_seconds: Option<u64>,
    pub password: Option<String>,
    pub download_limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudShareAccessQuery {
    pub password: Option<String>,
    pub download_session_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDownloadQuery {
    pub token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCloudFileRequest {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub content_type: Option<String>,
    pub last_modified: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteCloudShareRequest {
    pub uploaded_file_ids: Vec<String>,
    #[serde(default)]
    pub multipart_uploads: Vec<CompleteMultipartUploadRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteMultipartUploadRequest {
    pub file_id: String,
    pub upload_id: String,
    pub parts: Vec<CompleteMultipartUploadPartRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteMultipartUploadPartRequest {
    pub part_number: i32,
    pub e_tag: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbortCloudShareUploadsRequest {
    #[serde(default)]
    pub multipart_uploads: Vec<AbortMultipartUploadRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbortMultipartUploadRequest {
    pub file_id: String,
    pub upload_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CloudShareManifest {
    pub share_id: String,
    pub root_name: String,
    pub total_size: u64,
    pub total_files: usize,
    pub created_at: u64,
    pub expires_at: u64,
    pub completed: bool,
    pub files: Vec<CloudFileManifest>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CloudFileManifest {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub content_type: String,
    pub last_modified: Option<u64>,
    pub object_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCloudShareResponse {
    pub share_id: String,
    pub share_url: String,
    pub expires_at: u64,
    pub upload_url_ttl_seconds: u64,
    pub files: Vec<CloudUploadTarget>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudUploadTarget {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub upload_url: Option<String>,
    pub multipart: Option<CloudMultipartUploadTarget>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudMultipartUploadTarget {
    pub upload_id: String,
    pub part_size: u64,
    pub parts: Vec<CloudMultipartUploadPart>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudMultipartUploadPart {
    pub part_number: i32,
    pub offset: u64,
    pub size: u64,
    pub upload_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicCloudShareResponse {
    pub share_id: String,
    pub root_name: String,
    pub total_size: u64,
    pub total_files: usize,
    pub created_at: u64,
    pub expires_at: u64,
    pub seconds_until_expiry: u64,
    pub completed: bool,
    pub requires_password: bool,
    pub download_session_token: Option<String>,
    pub files: Vec<PublicCloudFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicCloudFile {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub content_type: String,
    pub last_modified: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPlansResponse {
    pub direct_p2p: DirectP2pPlan,
    pub free: CloudPlanLimit,
    pub passes: Vec<DropPassPlan>,
    pub pro: ProPlan,
    pub checkout_enabled: bool,
    pub payment_providers: Vec<PaymentProviderStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectP2pPlan {
    pub label: String,
    pub unlimited: bool,
    pub price_krw: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPlanLimit {
    pub sku: String,
    pub label: String,
    pub price_krw: u64,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub retention_seconds: u64,
    pub download_limit: Option<u32>,
    pub available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropPassPlan {
    #[serde(flatten)]
    pub limit: CloudPlanLimit,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProPlan {
    #[serde(flatten)]
    pub limit: CloudPlanLimit,
    pub monthly_quota_bytes: u64,
    pub concurrent_storage_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiErrorBody {
    error: String,
}

pub async fn create_cloud_share(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreateCloudShareRequest>,
) -> Response {
    match create_cloud_share_inner(state, request).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.into_response(),
    }
}

pub async fn get_cloud_plans(State(state): State<Arc<AppState>>) -> Json<CloudPlansResponse> {
    Json(cloud_plans_response(
        &state.config.cloud,
        state
            .billing
            .as_ref()
            .map(|billing| billing.payment_providers())
            .unwrap_or_default(),
    ))
}

pub async fn get_cloud_share(
    State(state): State<Arc<AppState>>,
    Path(share_id): Path<String>,
    Query(query): Query<CloudShareAccessQuery>,
) -> Response {
    match read_public_share(state, &share_id, query).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.into_response(),
    }
}

pub async fn access_cloud_share(
    State(state): State<Arc<AppState>>,
    Path(share_id): Path<String>,
    Json(request): Json<CloudShareAccessQuery>,
) -> Response {
    match read_public_share(state, &share_id, request).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.into_response(),
    }
}

pub async fn complete_cloud_share(
    State(state): State<Arc<AppState>>,
    Path(share_id): Path<String>,
    Json(request): Json<CompleteCloudShareRequest>,
) -> Response {
    match complete_cloud_share_inner(state, &share_id, request).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.into_response(),
    }
}

pub async fn abort_cloud_share_uploads(
    State(state): State<Arc<AppState>>,
    Path(share_id): Path<String>,
    Json(request): Json<AbortCloudShareUploadsRequest>,
) -> Response {
    match abort_cloud_share_uploads_inner(state, &share_id, request).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => error.into_response(),
    }
}

pub async fn download_cloud_file(
    State(state): State<Arc<AppState>>,
    Path((share_id, file_id)): Path<(String, String)>,
    Query(query): Query<CloudDownloadQuery>,
) -> Response {
    match download_cloud_file_inner(state, &share_id, &file_id, query).await {
        Ok(redirect) => redirect.into_response(),
        Err(error) => error.into_response(),
    }
}

fn cloud_plans_response(
    config: &CloudConfig,
    payment_providers: Vec<PaymentProviderStatus>,
) -> CloudPlansResponse {
    const GB: u64 = 1024 * 1024 * 1024;
    const TB: u64 = 1024 * GB;

    let billing_enabled = config.billing_enabled;
    let payment_providers = if payment_providers.is_empty() && billing_enabled {
        vec![PaymentProviderStatus {
            provider: CheckoutProvider::LemonSqueezy,
            label: "Lemon Squeezy".to_string(),
            available: false,
            default: true,
        }]
    } else {
        payment_providers
    };
    let checkout_enabled = payment_providers.iter().any(|provider| provider.available);
    CloudPlansResponse {
        direct_p2p: DirectP2pPlan {
            label: "Free Direct Send".to_string(),
            unlimited: true,
            price_krw: 0,
        },
        free: CloudPlanLimit {
            sku: "free_cloud_10gb_24h".to_string(),
            label: "PonsWarp Free".to_string(),
            price_krw: 0,
            max_total_bytes: config.max_total_bytes,
            max_file_bytes: config.max_file_bytes,
            retention_seconds: config.retention_seconds,
            download_limit: None,
            available: true,
        },
        passes: vec![
            DropPassPlan {
                limit: CloudPlanLimit {
                    sku: "drop_100gb_3d".to_string(),
                    label: "100GB Drop Pass".to_string(),
                    price_krw: 1_900,
                    max_total_bytes: 100 * GB,
                    max_file_bytes: 100 * GB,
                    retention_seconds: 3 * 24 * 60 * 60,
                    download_limit: Some(10),
                    available: checkout_enabled,
                },
            },
            DropPassPlan {
                limit: CloudPlanLimit {
                    sku: "drop_500gb_7d".to_string(),
                    label: "500GB Drop Pass".to_string(),
                    price_krw: 4_900,
                    max_total_bytes: 500 * GB,
                    max_file_bytes: 500 * GB,
                    retention_seconds: 7 * 24 * 60 * 60,
                    download_limit: Some(20),
                    available: checkout_enabled,
                },
            },
            DropPassPlan {
                limit: CloudPlanLimit {
                    sku: "drop_1tb_7d".to_string(),
                    label: "1TB Drop Pass".to_string(),
                    price_krw: 9_900,
                    max_total_bytes: TB,
                    max_file_bytes: TB,
                    retention_seconds: 7 * 24 * 60 * 60,
                    download_limit: Some(30),
                    available: checkout_enabled,
                },
            },
        ],
        pro: ProPlan {
            limit: CloudPlanLimit {
                sku: "pro_monthly_krw_9900".to_string(),
                label: "PonsWarp Pro".to_string(),
                price_krw: 9_900,
                max_total_bytes: TB,
                max_file_bytes: TB,
                retention_seconds: 7 * 24 * 60 * 60,
                download_limit: Some(30),
                available: checkout_enabled,
            },
            monthly_quota_bytes: 2 * TB,
            concurrent_storage_bytes: TB,
        },
        checkout_enabled,
        payment_providers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cloud_config() -> CloudConfig {
        const GB: u64 = 1024 * 1024 * 1024;
        CloudConfig {
            enabled: true,
            billing_enabled: true,
            bucket: "ponslink".to_string(),
            endpoint: "https://example.r2.cloudflarestorage.com".to_string(),
            access_key_id: "key".to_string(),
            secret_access_key: "secret".to_string(),
            region: "auto".to_string(),
            prefix: "ponswarp-cloud".to_string(),
            retention_seconds: 24 * 60 * 60,
            upload_url_ttl_seconds: 3600,
            download_url_ttl_seconds: 300,
            cleanup_interval_seconds: 300,
            cleanup_run_on_startup: true,
            max_files: 100,
            max_file_bytes: 10 * GB,
            max_total_bytes: 10 * GB,
        }
    }

    #[test]
    fn free_plan_exposes_zero_price_and_policy_limits() {
        let plans = cloud_plans_response(&cloud_config(), Vec::new());

        assert_eq!(plans.direct_p2p.price_krw, 0);
        assert!(plans.direct_p2p.unlimited);
        assert_eq!(plans.free.label, "PonsWarp Free");
        assert_eq!(plans.free.price_krw, 0);
        assert_eq!(plans.free.max_total_bytes, 10 * 1024 * 1024 * 1024);
        assert_eq!(plans.free.retention_seconds, 24 * 60 * 60);
        assert!(plans.free.available);
    }

    #[test]
    fn multipart_threshold_preserves_small_single_put_path() {
        assert!(!should_use_multipart(MULTIPART_UPLOAD_THRESHOLD_BYTES));
        assert!(should_use_multipart(MULTIPART_UPLOAD_THRESHOLD_BYTES + 1));
    }

    #[test]
    fn multipart_part_shape_respects_r2_limits() {
        let size = 10 * 1024 * 1024 * 1024_u64;
        let part_size = multipart_part_size(size).expect("part size");
        let part_count = multipart_part_count(size).expect("part count");

        assert!(part_size >= 5 * 1024 * 1024);
        assert!(part_size <= 5 * 1024 * 1024 * 1024);
        assert!(part_count <= MAX_MULTIPART_PARTS);
        assert_eq!(part_size, MULTIPART_UPLOAD_PART_BYTES);
        assert_eq!(part_count, 160);
    }

    #[test]
    fn cloud_share_codes_are_short_and_receive_friendly() {
        let code = random_cloud_share_code();

        assert_eq!(code.len(), CLOUD_SHARE_CODE_LEN);
        assert!(code
            .chars()
            .all(|ch| CLOUD_SHARE_CODE_ALPHABET.contains(&(ch as u8))));
    }
}

struct ResolvedCloudPolicy {
    max_files: usize,
    max_total_bytes: u64,
    max_file_bytes: u64,
    retention_seconds: u64,
    plan_snapshot: serde_json::Value,
    owner_user_id: Option<Uuid>,
    drop_pass_id: Option<Uuid>,
    password_hash: Option<String>,
    download_limit: Option<u32>,
}

impl From<ResolvedCloudPolicy> for crate::database::CloudSharePolicyRecord {
    fn from(policy: ResolvedCloudPolicy) -> Self {
        Self {
            plan_snapshot: policy.plan_snapshot,
            owner_user_id: policy.owner_user_id,
            drop_pass_id: policy.drop_pass_id,
            password_hash: policy.password_hash,
            download_limit: policy.download_limit,
        }
    }
}

async fn resolve_cloud_policy(
    state: &AppState,
    request: &CreateCloudShareRequest,
) -> Result<ResolvedCloudPolicy, CloudShareError> {
    let config = &state.config.cloud;
    let password = request
        .password
        .as_deref()
        .map(str::trim)
        .filter(|password| !password.is_empty());

    if let Some(token) = request
        .entitlement_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
    {
        let Some(database) = state.cloud_db.as_ref() else {
            return Err(CloudShareError::bad_request(
                "Paid Cloud Drop requires billing database",
            ));
        };
        let entitlement = database
            .resolve_entitlement(token.trim(), unix_now())
            .await
            .map_err(CloudShareError::internal)?
            .ok_or_else(|| CloudShareError::bad_request("Cloud Drop entitlement is not active"))?;
        let requested_total_size = request.files.iter().map(|file| file.size).sum::<u64>();
        if let Some(owner_user_id) = entitlement.owner_user_id {
            enforce_paid_usage_limits(database, owner_user_id, &entitlement, requested_total_size)
                .await?;
        }

        let retention_seconds = request
            .retention_seconds
            .unwrap_or(entitlement.retention_seconds)
            .clamp(1, entitlement.retention_seconds);
        let download_limit = match (request.download_limit, entitlement.download_limit) {
            (Some(requested), Some(maximum)) => Some(requested.clamp(1, maximum)),
            (Some(requested), None) => Some(requested),
            (None, maximum) => maximum,
        };

        return Ok(ResolvedCloudPolicy {
            max_files: config.max_files,
            max_total_bytes: entitlement.max_total_bytes,
            max_file_bytes: entitlement.max_file_bytes,
            retention_seconds,
            plan_snapshot: json!({
                "sku": entitlement.sku,
                "label": entitlement.label,
                "maxTotalBytes": entitlement.max_total_bytes,
                "maxFileBytes": entitlement.max_file_bytes,
                "retentionSeconds": retention_seconds,
            "downloadLimit": download_limit,
                "monthlyQuotaBytes": entitlement.monthly_quota_bytes,
                "concurrentStorageBytes": entitlement.concurrent_storage_bytes
            }),
            owner_user_id: entitlement.owner_user_id,
            drop_pass_id: entitlement.drop_pass_id,
            password_hash: password.map(|value| password_hash(state, value)),
            download_limit,
        });
    }

    if password.is_some() {
        return Err(CloudShareError::bad_request(
            "Password-protected Cloud Drop links require a paid Cloud Drop plan",
        ));
    }

    if request.download_limit.is_some() {
        return Err(CloudShareError::bad_request(
            "Download limits are not available yet",
        ));
    }

    let retention_seconds = request
        .retention_seconds
        .unwrap_or(config.retention_seconds)
        .clamp(1, config.retention_seconds);

    Ok(ResolvedCloudPolicy {
        max_files: config.max_files,
        max_total_bytes: config.max_total_bytes,
        max_file_bytes: config.max_file_bytes,
        retention_seconds,
        plan_snapshot: free_plan_snapshot(config, retention_seconds),
        owner_user_id: None,
        drop_pass_id: None,
        password_hash: None,
        download_limit: None,
    })
}

async fn enforce_paid_usage_limits(
    database: &crate::database::CloudDatabase,
    owner_user_id: Uuid,
    entitlement: &crate::database::EntitlementRecord,
    requested_total_size: u64,
) -> Result<(), CloudShareError> {
    if entitlement.monthly_quota_bytes.is_none() && entitlement.concurrent_storage_bytes.is_none() {
        return Ok(());
    }

    let now = unix_now();
    let rolling_month_start = now.saturating_sub(30 * 24 * 60 * 60);
    let usage = database
        .cloud_usage_for_user(owner_user_id, rolling_month_start, now)
        .await
        .map_err(CloudShareError::internal)?;

    if let Some(monthly_quota_bytes) = entitlement.monthly_quota_bytes {
        let next_monthly_total = usage
            .monthly_completed_bytes
            .saturating_add(requested_total_size);
        if next_monthly_total > monthly_quota_bytes {
            return Err(CloudShareError::forbidden(format!(
                "Monthly Cloud Drop quota exceeded. {} available in the current billing window.",
                format_bytes(monthly_quota_bytes.saturating_sub(usage.monthly_completed_bytes))
            )));
        }
    }

    if let Some(concurrent_storage_bytes) = entitlement.concurrent_storage_bytes {
        let next_reserved_total = usage
            .active_reserved_bytes
            .saturating_add(requested_total_size);
        if next_reserved_total > concurrent_storage_bytes {
            return Err(CloudShareError::forbidden(format!(
                "Concurrent Cloud Drop storage limit exceeded. {} available until older drops expire.",
                format_bytes(concurrent_storage_bytes.saturating_sub(usage.active_reserved_bytes))
            )));
        }
    }

    Ok(())
}

fn free_plan_snapshot(config: &CloudConfig, retention_seconds: u64) -> serde_json::Value {
    json!({
        "sku": "free_cloud_10gb_24h",
        "label": "PonsWarp Free",
        "priceKrw": 0,
        "maxTotalBytes": config.max_total_bytes,
        "maxFileBytes": config.max_file_bytes,
        "retentionSeconds": retention_seconds
    })
}

async fn create_cloud_share_inner(
    state: Arc<AppState>,
    request: CreateCloudShareRequest,
) -> Result<CreateCloudShareResponse, CloudShareError> {
    let storage = state.cloud_storage()?;
    let policy = resolve_cloud_policy(&state, &request).await?;
    validate_create_request(&policy, &request)?;

    let now = unix_now();
    let expires_at = now + policy.retention_seconds;
    let drop_pass_to_consume = policy.drop_pass_id;
    let share_id = random_cloud_share_code();
    let root_name = clamp_name(&request.root_name, "Cloud Drop");

    let mut manifest_files = Vec::with_capacity(request.files.len());
    let mut upload_targets = Vec::with_capacity(request.files.len());

    for file in request.files {
        let id = Uuid::new_v4().simple().to_string();
        let object_key = storage.file_key(&share_id, &id);
        let content_type = file
            .content_type
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let name = clamp_name(&file.name, "download.bin");
        let path = clamp_path(&file.path, &name);

        manifest_files.push(CloudFileManifest {
            id: id.clone(),
            name: name.clone(),
            path: path.clone(),
            size: file.size,
            content_type: content_type.clone(),
            last_modified: file.last_modified,
            object_key: object_key.clone(),
        });

        let upload = presign_upload_target(
            storage,
            &object_key,
            &content_type,
            file.size,
            state.config.cloud.upload_url_ttl_seconds,
        )
        .await?;
        upload_targets.push(CloudUploadTarget {
            id,
            name,
            path,
            size: file.size,
            upload_url: upload.upload_url,
            multipart: upload.multipart,
        });
    }

    let manifest = CloudShareManifest {
        total_size: manifest_files.iter().map(|file| file.size).sum(),
        total_files: manifest_files.len(),
        share_id: share_id.clone(),
        root_name,
        created_at: now,
        expires_at,
        completed: false,
        files: manifest_files,
    };

    if let Some(database) = state.cloud_db.as_ref() {
        database
            .insert_cloud_share(&manifest, policy.into())
            .await
            .map_err(CloudShareError::internal)?;
    }
    if let Err(error) = write_manifest(storage, &manifest).await {
        if let Some(database) = state.cloud_db.as_ref() {
            let _ = database
                .mark_cloud_share_deleted(&manifest.share_id, unix_now())
                .await;
        }
        return Err(error);
    }
    if let Some(drop_pass_id) = drop_pass_to_consume {
        if let Some(database) = state.cloud_db.as_ref() {
            let consumed = database
                .consume_drop_pass(drop_pass_id)
                .await
                .map_err(CloudShareError::internal)?;
            if !consumed {
                let _ = database
                    .mark_cloud_share_deleted(&manifest.share_id, unix_now())
                    .await;
                let _ = delete_manifest(storage, &manifest.share_id).await;
                return Err(CloudShareError::bad_request(
                    "Cloud Drop entitlement was already used",
                ));
            }
        }
    }

    Ok(CreateCloudShareResponse {
        share_url: format!("/cloud/{}", share_id),
        share_id,
        expires_at,
        upload_url_ttl_seconds: state.config.cloud.upload_url_ttl_seconds,
        files: upload_targets,
    })
}

async fn complete_cloud_share_inner(
    state: Arc<AppState>,
    share_id: &str,
    request: CompleteCloudShareRequest,
) -> Result<PublicCloudShareResponse, CloudShareError> {
    let storage = state.cloud_storage()?;
    let mut manifest = read_share_manifest(&state, storage, share_id).await?;
    reject_expired(&manifest)?;

    let expected: std::collections::HashSet<&str> =
        manifest.files.iter().map(|file| file.id.as_str()).collect();
    let uploaded: std::collections::HashSet<&str> = request
        .uploaded_file_ids
        .iter()
        .map(String::as_str)
        .collect();
    if expected != uploaded {
        return Err(CloudShareError::bad_request(
            "Uploaded file list does not match the created share",
        ));
    }

    for multipart_upload in request.multipart_uploads {
        complete_cloud_file_multipart_upload(storage, &manifest, multipart_upload).await?;
    }

    for file in &manifest.files {
        ensure_object_exists(storage, &file.object_key, file.size).await?;
    }

    manifest.completed = true;
    if let Some(database) = state.cloud_db.as_ref() {
        database
            .mark_cloud_share_completed(&manifest.share_id, manifest.total_size, unix_now())
            .await
            .map_err(CloudShareError::internal)?;
    }
    write_manifest(storage, &manifest).await?;
    Ok(public_share(manifest, None, false))
}

async fn complete_cloud_file_multipart_upload(
    storage: &CloudStorage,
    manifest: &CloudShareManifest,
    request: CompleteMultipartUploadRequest,
) -> Result<(), CloudShareError> {
    if manifest.completed {
        return Err(CloudShareError::conflict(
            "Share upload is already complete",
        ));
    }
    let file = manifest
        .files
        .iter()
        .find(|file| file.id == request.file_id)
        .ok_or_else(|| CloudShareError::not_found("File not found"))?;
    if !should_use_multipart(file.size) {
        return Err(CloudShareError::bad_request(
            "Multipart completion is only valid for multipart upload targets",
        ));
    }
    if request.upload_id.trim().is_empty() {
        return Err(CloudShareError::bad_request(
            "Multipart upload ID is required",
        ));
    }
    let expected_parts = multipart_part_count(file.size)?;
    if request.parts.len() as u64 != expected_parts {
        return Err(CloudShareError::bad_request(
            "Uploaded part list does not match the created multipart upload",
        ));
    }

    let mut parts = request
        .parts
        .into_iter()
        .map(|part| {
            let e_tag = part.e_tag.trim().to_string();
            if part.part_number < 1 || e_tag.is_empty() {
                return Err(CloudShareError::bad_request(
                    "Multipart completion requires valid part numbers and ETags",
                ));
            }
            Ok(CompletedPart::builder()
                .part_number(part.part_number)
                .e_tag(e_tag)
                .build())
        })
        .collect::<Result<Vec<_>, _>>()?;
    parts.sort_by_key(|part| part.part_number().unwrap_or_default());

    for (index, part) in parts.iter().enumerate() {
        if part.part_number() != Some((index + 1) as i32) {
            return Err(CloudShareError::bad_request(
                "Multipart parts must be consecutive and start at 1",
            ));
        }
    }

    let upload = CompletedMultipartUpload::builder()
        .set_parts(Some(parts))
        .build();
    let upload_id = request.upload_id.trim();
    if let Err(error) = storage
        .client
        .complete_multipart_upload()
        .bucket(&storage.bucket)
        .key(&file.object_key)
        .upload_id(upload_id)
        .multipart_upload(upload)
        .send()
        .await
    {
        let _ = abort_multipart_upload(storage, &file.object_key, upload_id).await;
        return Err(CloudShareError::internal(error));
    }

    ensure_object_exists(storage, &file.object_key, file.size).await?;
    Ok(())
}

async fn abort_cloud_share_uploads_inner(
    state: Arc<AppState>,
    share_id: &str,
    request: AbortCloudShareUploadsRequest,
) -> Result<(), CloudShareError> {
    let storage = state.cloud_storage()?;
    let manifest = read_share_manifest(&state, storage, share_id).await?;

    for multipart_upload in request.multipart_uploads {
        let Some(file) = manifest
            .files
            .iter()
            .find(|file| file.id == multipart_upload.file_id)
        else {
            continue;
        };
        if !should_use_multipart(file.size) || multipart_upload.upload_id.trim().is_empty() {
            continue;
        }

        if let Err(error) =
            abort_multipart_upload(storage, &file.object_key, multipart_upload.upload_id.trim())
                .await
        {
            tracing::warn!(
                share_id = %manifest.share_id,
                file_id = %file.id,
                error = ?error,
                "failed to abort incomplete multipart upload"
            );
        }
    }

    Ok(())
}

async fn read_public_share(
    state: Arc<AppState>,
    share_id: &str,
    query: CloudShareAccessQuery,
) -> Result<PublicCloudShareResponse, CloudShareError> {
    let storage = state.cloud_storage()?;
    let manifest = read_share_manifest(&state, storage, share_id).await?;
    reject_expired(&manifest)?;
    let access = authorize_public_access(&state, &manifest, query).await?;
    Ok(public_share(
        manifest,
        access.download_session_token,
        access.requires_password,
    ))
}

async fn download_cloud_file_inner(
    state: Arc<AppState>,
    share_id: &str,
    file_id: &str,
    query: CloudDownloadQuery,
) -> Result<Redirect, CloudShareError> {
    let storage = state.cloud_storage()?;
    let manifest = read_share_manifest(&state, storage, share_id).await?;
    reject_expired(&manifest)?;
    if !manifest.completed {
        return Err(CloudShareError::conflict(
            "Share upload is not complete yet",
        ));
    }

    let file = manifest
        .files
        .iter()
        .find(|file| file.id == file_id)
        .ok_or_else(|| CloudShareError::not_found("File not found"))?;

    authorize_file_download(&state, &manifest, query).await?;

    let presigned = storage
        .client
        .get_object()
        .bucket(&storage.bucket)
        .key(&file.object_key)
        .response_content_disposition(format!(
            "attachment; filename=\"{}\"",
            sanitize_ascii_filename(&file.name)
        ))
        .presigned(presign_config(state.config.cloud.download_url_ttl_seconds)?)
        .await
        .map_err(CloudShareError::internal)?;

    Ok(Redirect::temporary(presigned.uri()))
}

struct AuthorizedCloudAccess {
    download_session_token: Option<String>,
    requires_password: bool,
}

async fn authorize_public_access(
    state: &AppState,
    manifest: &CloudShareManifest,
    query: CloudShareAccessQuery,
) -> Result<AuthorizedCloudAccess, CloudShareError> {
    let Some(database) = state.cloud_db.as_ref() else {
        return Ok(AuthorizedCloudAccess {
            download_session_token: None,
            requires_password: false,
        });
    };
    let Some(access) = database
        .cloud_share_access(&manifest.share_id)
        .await
        .map_err(CloudShareError::internal)?
    else {
        return Ok(AuthorizedCloudAccess {
            download_session_token: None,
            requires_password: false,
        });
    };

    let protected = access.password_hash.is_some();
    let limited = access.download_limit.is_some();
    if !protected && !limited {
        return Ok(AuthorizedCloudAccess {
            download_session_token: None,
            requires_password: false,
        });
    }

    if let Some(token) = query
        .download_session_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
    {
        if database
            .cloud_download_session_exists(
                &manifest.share_id,
                &token_hash(state, token),
                unix_now(),
            )
            .await
            .map_err(CloudShareError::internal)?
        {
            return Ok(AuthorizedCloudAccess {
                download_session_token: Some(token.to_string()),
                requires_password: protected,
            });
        }
    }

    if let Some(expected_hash) = access.password_hash.as_deref() {
        let Some(password) = query.password.as_deref() else {
            return Err(CloudShareError::forbidden("Password required"));
        };
        if !verify_password_hash(state, password, expected_hash) {
            return Err(CloudShareError::forbidden("Invalid password"));
        }
    }

    let token = random_token(32);
    database
        .insert_cloud_download_session(
            &manifest.share_id,
            &token_hash(state, &token),
            unix_now(),
            manifest.expires_at,
        )
        .await
        .map_err(CloudShareError::internal)?;
    Ok(AuthorizedCloudAccess {
        download_session_token: Some(token),
        requires_password: protected,
    })
}

async fn authorize_file_download(
    state: &AppState,
    manifest: &CloudShareManifest,
    query: CloudDownloadQuery,
) -> Result<(), CloudShareError> {
    let Some(database) = state.cloud_db.as_ref() else {
        return Ok(());
    };
    let Some(access) = database
        .cloud_share_access(&manifest.share_id)
        .await
        .map_err(CloudShareError::internal)?
    else {
        return Ok(());
    };

    let protected = access.password_hash.is_some();
    let limited = access.download_limit.is_some();
    if !protected && !limited {
        return Ok(());
    }

    let token = query
        .token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| CloudShareError::forbidden("Download session required"))?;
    let allowed = database
        .consume_download_session(&manifest.share_id, &token_hash(state, token), unix_now())
        .await
        .map_err(CloudShareError::internal)?;
    if !allowed {
        return Err(CloudShareError::forbidden("Download limit reached"));
    }

    Ok(())
}

pub async fn cleanup_expired_cloud_shares(state: Arc<AppState>) {
    let Some(storage) = state.cloud.as_ref() else {
        return;
    };

    let manifest_prefix = storage.manifest_prefix();
    let mut continuation_token = None;

    loop {
        let response = storage
            .client
            .list_objects_v2()
            .bucket(&storage.bucket)
            .prefix(&manifest_prefix)
            .set_continuation_token(continuation_token)
            .send()
            .await;

        let Ok(response) = response else {
            tracing::warn!("Cloud share cleanup list_objects_v2 failed");
            return;
        };

        for object in response.contents() {
            let Some(key) = object.key() else {
                continue;
            };

            let Ok(manifest) = read_manifest_by_key(storage, key).await else {
                continue;
            };

            if manifest.expires_at > unix_now() {
                continue;
            }

            for file in &manifest.files {
                let _ = storage
                    .client
                    .delete_object()
                    .bucket(&storage.bucket)
                    .key(&file.object_key)
                    .send()
                    .await;
            }
            let _ = storage
                .client
                .delete_object()
                .bucket(&storage.bucket)
                .key(key)
                .send()
                .await;
            if let Some(database) = state.cloud_db.as_ref() {
                let _ = database
                    .mark_cloud_share_deleted(&manifest.share_id, unix_now())
                    .await;
            }
            tracing::info!(share_id = %manifest.share_id, "Expired cloud share deleted");
        }

        if response.is_truncated().unwrap_or(false) {
            continuation_token = response.next_continuation_token().map(str::to_string);
        } else {
            break;
        }
    }
}

fn validate_create_request(
    policy: &ResolvedCloudPolicy,
    request: &CreateCloudShareRequest,
) -> Result<(), CloudShareError> {
    if request.files.is_empty() {
        return Err(CloudShareError::bad_request(
            "At least one file is required",
        ));
    }
    if request.files.len() > policy.max_files {
        return Err(CloudShareError::bad_request(
            "Too many files in one cloud share",
        ));
    }
    let total_size: u64 = request.files.iter().map(|file| file.size).sum();
    if total_size > policy.max_total_bytes {
        return Err(CloudShareError::bad_request(format!(
            "Cloud Drop is limited to {}. Use direct P2P for unlimited transfer or split files into 10GB batches.",
            format_bytes(policy.max_total_bytes)
        )));
    }
    if request
        .files
        .iter()
        .any(|file| file.size > policy.max_file_bytes)
    {
        return Err(CloudShareError::bad_request(format!(
            "Each Cloud Drop file is limited to {}. Use direct P2P for unlimited transfer or split the file.",
            format_bytes(policy.max_file_bytes)
        )));
    }
    if request.files.iter().any(|file| file.size == 0) {
        return Err(CloudShareError::bad_request(
            "Empty files are not supported",
        ));
    }
    Ok(())
}

struct PresignedUploadTarget {
    upload_url: Option<String>,
    multipart: Option<CloudMultipartUploadTarget>,
}

async fn presign_upload_target(
    storage: &CloudStorage,
    object_key: &str,
    content_type: &str,
    size: u64,
    ttl_seconds: u64,
) -> Result<PresignedUploadTarget, CloudShareError> {
    if should_use_multipart(size) {
        let multipart =
            presign_multipart_upload(storage, object_key, content_type, size, ttl_seconds).await?;
        return Ok(PresignedUploadTarget {
            upload_url: None,
            multipart: Some(multipart),
        });
    }

    Ok(PresignedUploadTarget {
        upload_url: Some(presign_put(storage, object_key, ttl_seconds).await?),
        multipart: None,
    })
}

async fn presign_put(
    storage: &CloudStorage,
    object_key: &str,
    ttl_seconds: u64,
) -> Result<String, CloudShareError> {
    let presigned = storage
        .client
        .put_object()
        .bucket(&storage.bucket)
        .key(object_key)
        .presigned(presign_config(ttl_seconds)?)
        .await
        .map_err(CloudShareError::internal)?;

    Ok(presigned.uri().to_string())
}

async fn presign_multipart_upload(
    storage: &CloudStorage,
    object_key: &str,
    content_type: &str,
    size: u64,
    ttl_seconds: u64,
) -> Result<CloudMultipartUploadTarget, CloudShareError> {
    let upload = storage
        .client
        .create_multipart_upload()
        .bucket(&storage.bucket)
        .key(object_key)
        .content_type(content_type)
        .send()
        .await
        .map_err(CloudShareError::internal)?;
    let upload_id = upload
        .upload_id()
        .ok_or_else(|| CloudShareError::internal("R2 did not return a multipart upload ID"))?;
    let part_size = multipart_part_size(size)?;
    let mut parts = Vec::with_capacity(multipart_part_count(size)? as usize);
    let part_count = multipart_part_count(size)?;

    for index in 0..part_count {
        let offset = index * part_size;
        let part_number = i32::try_from(index + 1).map_err(CloudShareError::internal)?;
        let part_size = if index + 1 == part_count {
            size.saturating_sub(offset)
        } else {
            part_size
        };
        let presigned = storage
            .client
            .upload_part()
            .bucket(&storage.bucket)
            .key(object_key)
            .upload_id(upload_id)
            .part_number(part_number)
            .presigned(presign_config(ttl_seconds)?)
            .await
            .map_err(CloudShareError::internal)?;
        parts.push(CloudMultipartUploadPart {
            part_number,
            offset,
            size: part_size,
            upload_url: presigned.uri().to_string(),
        });
    }

    Ok(CloudMultipartUploadTarget {
        upload_id: upload_id.to_string(),
        part_size,
        parts,
    })
}

async fn abort_multipart_upload(
    storage: &CloudStorage,
    object_key: &str,
    upload_id: &str,
) -> Result<(), CloudShareError> {
    storage
        .client
        .abort_multipart_upload()
        .bucket(&storage.bucket)
        .key(object_key)
        .upload_id(upload_id)
        .send()
        .await
        .map_err(CloudShareError::internal)?;
    Ok(())
}

fn should_use_multipart(size: u64) -> bool {
    size > MULTIPART_UPLOAD_THRESHOLD_BYTES
}

fn multipart_part_size(size: u64) -> Result<u64, CloudShareError> {
    if size == 0 {
        return Err(CloudShareError::bad_request(
            "Empty files are not supported",
        ));
    }
    let minimum_part_size = size.div_ceil(MAX_MULTIPART_PARTS).max(5 * 1024 * 1024);
    Ok(MULTIPART_UPLOAD_PART_BYTES.max(minimum_part_size))
}

fn multipart_part_count(size: u64) -> Result<u64, CloudShareError> {
    let part_size = multipart_part_size(size)?;
    let part_count = size.div_ceil(part_size);
    if part_count == 0 || part_count > MAX_MULTIPART_PARTS {
        return Err(CloudShareError::bad_request(
            "File is too large for multipart Cloud Drop upload",
        ));
    }
    Ok(part_count)
}

async fn ensure_object_exists(
    storage: &CloudStorage,
    object_key: &str,
    expected_size: u64,
) -> Result<(), CloudShareError> {
    let output = storage
        .client
        .head_object()
        .bucket(&storage.bucket)
        .key(object_key)
        .send()
        .await
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("NoSuchKey") || message.contains("NotFound") {
                CloudShareError::conflict("Uploaded object is not available yet")
            } else {
                CloudShareError::internal(error)
            }
        })?;
    if output.content_length().unwrap_or_default() < 0
        || output.content_length().unwrap_or_default() as u64 != expected_size
    {
        return Err(CloudShareError::conflict(
            "Uploaded object size does not match the created share",
        ));
    }
    Ok(())
}

fn presign_config(ttl_seconds: u64) -> Result<PresigningConfig, CloudShareError> {
    PresigningConfig::builder()
        .expires_in(Duration::from_secs(ttl_seconds.min(604_800)))
        .build()
        .map_err(CloudShareError::internal)
}

async fn write_manifest(
    storage: &CloudStorage,
    manifest: &CloudShareManifest,
) -> Result<(), CloudShareError> {
    let body = serde_json::to_vec(manifest).map_err(CloudShareError::internal)?;
    storage
        .client
        .put_object()
        .bucket(&storage.bucket)
        .key(storage.manifest_key(&manifest.share_id))
        .content_type("application/json")
        .body(ByteStream::from(body))
        .send()
        .await
        .map_err(CloudShareError::internal)?;
    Ok(())
}

async fn delete_manifest(storage: &CloudStorage, share_id: &str) -> Result<(), CloudShareError> {
    storage
        .client
        .delete_object()
        .bucket(&storage.bucket)
        .key(storage.manifest_key(share_id))
        .send()
        .await
        .map_err(CloudShareError::internal)?;
    Ok(())
}

async fn read_manifest(
    storage: &CloudStorage,
    share_id: &str,
) -> Result<CloudShareManifest, CloudShareError> {
    read_manifest_by_key(storage, &storage.manifest_key(share_id)).await
}

async fn read_share_manifest(
    state: &AppState,
    storage: &CloudStorage,
    share_id: &str,
) -> Result<CloudShareManifest, CloudShareError> {
    if let Some(database) = state.cloud_db.as_ref() {
        match database
            .read_cloud_share(share_id)
            .await
            .map_err(CloudShareError::internal)?
        {
            Some(manifest) => return Ok(manifest),
            None => {
                tracing::debug!(share_id = %share_id, "Cloud share not found in DB; falling back to R2 manifest");
            }
        }
    }

    read_manifest(storage, share_id).await
}

async fn read_manifest_by_key(
    storage: &CloudStorage,
    key: &str,
) -> Result<CloudShareManifest, CloudShareError> {
    let output = storage
        .client
        .get_object()
        .bucket(&storage.bucket)
        .key(key)
        .send()
        .await
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("NoSuchKey") || message.contains("NotFound") {
                CloudShareError::not_found("Share not found")
            } else {
                CloudShareError::internal(error)
            }
        })?;
    let bytes = output
        .body
        .collect()
        .await
        .map_err(CloudShareError::internal)?
        .into_bytes();
    serde_json::from_slice(&bytes).map_err(CloudShareError::internal)
}

fn public_share(
    manifest: CloudShareManifest,
    download_session_token: Option<String>,
    requires_password: bool,
) -> PublicCloudShareResponse {
    let now = unix_now();
    PublicCloudShareResponse {
        share_id: manifest.share_id,
        root_name: manifest.root_name,
        total_size: manifest.total_size,
        total_files: manifest.total_files,
        created_at: manifest.created_at,
        expires_at: manifest.expires_at,
        seconds_until_expiry: manifest.expires_at.saturating_sub(now),
        completed: manifest.completed,
        requires_password,
        download_session_token,
        files: manifest
            .files
            .into_iter()
            .map(|file| PublicCloudFile {
                id: file.id,
                name: file.name,
                path: file.path,
                size: file.size,
                content_type: file.content_type,
                last_modified: file.last_modified,
            })
            .collect(),
    }
}

fn password_hash(state: &AppState, password: &str) -> String {
    let salt = random_token(16);
    let digest = keyed_digest(state, &format!("{salt}:{password}"));
    format!("hmac-sha256:v1:{salt}:{digest}")
}

fn verify_password_hash(state: &AppState, password: &str, expected: &str) -> bool {
    let parts = expected.split(':').collect::<Vec<_>>();
    if parts.len() != 4 || parts[0] != "hmac-sha256" || parts[1] != "v1" {
        return false;
    }
    let candidate = keyed_digest(state, &format!("{}:{password}", parts[2]));
    constant_time_eq(candidate.as_bytes(), parts[3].as_bytes())
}

fn token_hash(state: &AppState, token: &str) -> String {
    keyed_digest(state, token)
}

fn keyed_digest(state: &AppState, value: &str) -> String {
    let secret = state.config.auth.session_secret.as_bytes();
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(value.as_bytes());
    hex(mac.finalize().into_bytes().as_slice())
}

fn random_token(bytes: usize) -> String {
    let mut data = vec![0_u8; bytes];
    rand::thread_rng().fill_bytes(&mut data);
    URL_SAFE_NO_PAD.encode(data)
}

fn random_cloud_share_code() -> String {
    let mut data = [0_u8; CLOUD_SHARE_CODE_LEN];
    rand::thread_rng().fill_bytes(&mut data);
    data.iter()
        .map(|byte| {
            CLOUD_SHARE_CODE_ALPHABET[*byte as usize % CLOUD_SHARE_CODE_ALPHABET.len()] as char
        })
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn reject_expired(manifest: &CloudShareManifest) -> Result<(), CloudShareError> {
    if manifest.expires_at <= unix_now() {
        return Err(CloudShareError::gone("Share has expired"));
    }
    Ok(())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn clamp_name(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(180).collect()
    }
}

fn clamp_path(path: &str, fallback_name: &str) -> String {
    let cleaned = path
        .split('/')
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .collect::<Vec<_>>()
        .join("/");
    if cleaned.is_empty() {
        fallback_name.to_string()
    } else {
        cleaned.chars().take(512).collect()
    }
}

fn sanitize_ascii_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '"' | '\\' | '\r' | '\n' => '_',
            c if c.is_ascii_graphic() || c == ' ' => c,
            _ => '_',
        })
        .collect()
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[unit])
    } else {
        format!("{:.0} {}", size, UNITS[unit])
    }
}

#[derive(Debug)]
pub struct CloudShareError {
    status: StatusCode,
    message: String,
}

impl CloudShareError {
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    pub(crate) fn gone(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::GONE,
            message: message.into(),
        }
    }

    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }

    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }

    pub(crate) fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(error = %error, "Cloud share operation failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "Cloud share service failed".to_string(),
        }
    }
}

impl IntoResponse for CloudShareError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ApiErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}