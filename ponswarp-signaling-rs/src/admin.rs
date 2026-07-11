//! Admin dashboard API foundation.

use crate::auth::{current_session_user, UserIdentity};
use crate::database::AdminMemberRecord;
use crate::state::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminMeResponse {
    authenticated: bool,
    user: AdminUserResponse,
    admin: AdminRoleResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUserResponse {
    id: String,
    email: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminRoleResponse {
    role: String,
    status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminOverviewResponse {
    total_users: i64,
    active_subscriptions: i64,
    active_drop_passes: i64,
    active_cloud_shares: i64,
    stored_cloud_bytes: i64,
    billing_events: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminOperationsResponse {
    users: Vec<AdminUserListResponse>,
    subscriptions: Vec<AdminSubscriptionListResponse>,
    drop_passes: Vec<AdminDropPassListResponse>,
    cloud_shares: Vec<AdminCloudShareListResponse>,
    billing_events: Vec<AdminBillingEventListResponse>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUserListResponse {
    id: String,
    email: String,
    name: Option<String>,
    plan: String,
    created_at: u64,
    last_login_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminSubscriptionListResponse {
    id: String,
    email: String,
    status: String,
    provider_subscription_id: Option<String>,
    current_period_end: Option<u64>,
    updated_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminDropPassListResponse {
    id: String,
    email: Option<String>,
    sku: String,
    status: String,
    remaining_uses: i32,
    max_total_bytes: u64,
    retention_seconds: u64,
    created_at: u64,
    expires_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminCloudShareListResponse {
    id: String,
    owner_email: Option<String>,
    root_name: String,
    total_size: u64,
    total_files: i32,
    completed: bool,
    download_count: i32,
    download_limit: Option<i32>,
    created_at: u64,
    expires_at: u64,
    deleted_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminBillingEventListResponse {
    provider: String,
    id: String,
    event_type: String,
    created_at: u64,
    processed_at: u64,
}

#[derive(Debug, Serialize)]
struct AdminErrorBody {
    error: String,
}

pub async fn me(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some((user, admin)) = require_admin(&state, &headers).await else {
        return admin_error(StatusCode::FORBIDDEN, "Admin access is required");
    };

    Json(AdminMeResponse {
        authenticated: true,
        user: AdminUserResponse {
            id: user.id.to_string(),
            email: user.email,
        },
        admin: AdminRoleResponse {
            role: admin.role,
            status: admin.status,
        },
    })
    .into_response()
}

pub async fn overview(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some((_user, _admin)) = require_admin(&state, &headers).await else {
        return admin_error(StatusCode::FORBIDDEN, "Admin access is required");
    };
    let Some(database) = state.cloud_db.as_ref() else {
        return admin_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Admin database is not available",
        );
    };

    match database.admin_overview(unix_now()).await {
        Ok(overview) => Json(AdminOverviewResponse {
            total_users: overview.total_users,
            active_subscriptions: overview.active_subscriptions,
            active_drop_passes: overview.active_drop_passes,
            active_cloud_shares: overview.active_cloud_shares,
            stored_cloud_bytes: overview.stored_cloud_bytes,
            billing_events: overview.billing_events,
        })
        .into_response(),
        Err(error) => {
            tracing::error!(error = %error, "Failed to load admin overview");
            admin_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load admin overview",
            )
        }
    }
}

pub async fn operations(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some((_user, _admin)) = require_admin(&state, &headers).await else {
        return admin_error(StatusCode::FORBIDDEN, "Admin access is required");
    };
    let Some(database) = state.cloud_db.as_ref() else {
        return admin_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Admin database is not available",
        );
    };

    match database.admin_operations().await {
        Ok(operations) => Json(AdminOperationsResponse {
            users: operations
                .users
                .into_iter()
                .map(|user| AdminUserListResponse {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    plan: user.plan,
                    created_at: user.created_at,
                    last_login_at: user.last_login_at,
                })
                .collect(),
            subscriptions: operations
                .subscriptions
                .into_iter()
                .map(|subscription| AdminSubscriptionListResponse {
                    id: subscription.id,
                    email: subscription.email,
                    status: subscription.status,
                    provider_subscription_id: subscription.provider_subscription_id,
                    current_period_end: subscription.current_period_end,
                    updated_at: subscription.updated_at,
                })
                .collect(),
            drop_passes: operations
                .drop_passes
                .into_iter()
                .map(|drop_pass| AdminDropPassListResponse {
                    id: drop_pass.id,
                    email: drop_pass.email,
                    sku: drop_pass.sku,
                    status: drop_pass.status,
                    remaining_uses: drop_pass.remaining_uses,
                    max_total_bytes: drop_pass.max_total_bytes,
                    retention_seconds: drop_pass.retention_seconds,
                    created_at: drop_pass.created_at,
                    expires_at: drop_pass.expires_at,
                })
                .collect(),
            cloud_shares: operations
                .cloud_shares
                .into_iter()
                .map(|share| AdminCloudShareListResponse {
                    id: share.id,
                    owner_email: share.owner_email,
                    root_name: share.root_name,
                    total_size: share.total_size,
                    total_files: share.total_files,
                    completed: share.completed,
                    download_count: share.download_count,
                    download_limit: share.download_limit,
                    created_at: share.created_at,
                    expires_at: share.expires_at,
                    deleted_at: share.deleted_at,
                })
                .collect(),
            billing_events: operations
                .billing_events
                .into_iter()
                .map(|event| AdminBillingEventListResponse {
                    provider: event.provider,
                    id: event.id,
                    event_type: event.event_type,
                    created_at: event.created_at,
                    processed_at: event.processed_at,
                })
                .collect(),
        })
        .into_response(),
        Err(error) => {
            tracing::error!(error = %error, "Failed to load admin operations");
            admin_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load admin operations",
            )
        }
    }
}

async fn require_admin(
    state: &AppState,
    headers: &HeaderMap,
) -> Option<(UserIdentity, AdminMemberRecord)> {
    let user = match current_session_user(state, headers).await {
        Ok(Some(user)) => user,
        Ok(None) => return None,
        Err(error) => {
            tracing::error!(?error, "Failed to resolve current admin session");
            return None;
        }
    };
    let database = state.cloud_db.as_ref()?;

    match database.admin_for_user(user.id).await {
        Ok(Some(admin)) => return Some((user, admin)),
        Ok(None) => {}
        Err(error) => {
            tracing::error!(error = %error, user_id = %user.id, "Failed to load admin member");
            return None;
        }
    }

    if !state
        .config
        .admin
        .bootstrap_emails
        .iter()
        .any(|email| email.eq_ignore_ascii_case(&user.email))
    {
        return None;
    }

    if let Err(error) = database.ensure_bootstrap_admin(user.id, unix_now()).await {
        tracing::error!(error = %error, user_id = %user.id, "Failed to bootstrap admin member");
        return None;
    }

    match database.admin_for_user(user.id).await {
        Ok(Some(admin)) => Some((user, admin)),
        Ok(None) => None,
        Err(error) => {
            tracing::error!(error = %error, user_id = %user.id, "Failed to reload bootstrap admin");
            None
        }
    }
}

fn admin_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(AdminErrorBody {
            error: message.to_string(),
        }),
    )
        .into_response()
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
