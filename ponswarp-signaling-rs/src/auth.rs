//! Google OAuth sign-in and HttpOnly browser sessions.

use crate::database::{AuthUserRecord, CloudDatabase, GoogleUserInput};
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::http::header::{COOKIE, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::Sha1;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

type HmacSha1 = Hmac<Sha1>;

#[derive(Debug, Clone)]
pub struct UserIdentity {
    pub id: Uuid,
    pub email: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStartQuery {
    return_to: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GoogleCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    authenticated: bool,
    user: Option<AuthUserResponse>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUserResponse {
    id: String,
    email: String,
    name: Option<String>,
    picture_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    id_token: String,
}

#[derive(Debug, Deserialize)]
struct GoogleTokenInfo {
    aud: String,
    sub: String,
    email: Option<String>,
    email_verified: Value,
    name: Option<String>,
    picture: Option<String>,
}

#[derive(Debug, Serialize)]
struct AuthErrorBody {
    error: String,
}

pub async fn me(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    match current_auth_user(&state, &headers).await {
        Ok(Some(user)) => Json(MeResponse {
            authenticated: true,
            user: Some(user.into()),
        })
        .into_response(),
        Ok(None) => Json(MeResponse {
            authenticated: false,
            user: None,
        })
        .into_response(),
        Err(error) => error.into_response(),
    }
}

pub async fn google_start(
    State(state): State<Arc<AppState>>,
    Query(query): Query<GoogleStartQuery>,
) -> Response {
    let Some(database) = state.cloud_db.as_ref() else {
        return AuthError::unavailable("Auth database is not available").into_response();
    };
    if let Err(error) = ensure_auth_configured(&state) {
        return error.into_response();
    }

    let now = unix_now();
    let state_token = random_token(32);
    let return_path = safe_return_path(query.return_to.as_deref());
    if let Err(error) = database
        .insert_oauth_state(&state_token, &return_path, now, now + 10 * 60)
        .await
    {
        return AuthError::internal(error).into_response();
    }

    let redirect_uri = google_redirect_uri(&state);
    let mut url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .expect("static Google OAuth URL is valid");
    url.query_pairs_mut()
        .append_pair("client_id", &state.config.auth.google_client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email profile")
        .append_pair("state", &state_token)
        .append_pair("access_type", "online")
        .append_pair("prompt", "select_account");

    Redirect::to(url.as_str()).into_response()
}

pub async fn google_callback(
    State(state): State<Arc<AppState>>,
    Query(query): Query<GoogleCallbackQuery>,
) -> Response {
    let Some(database) = state.cloud_db.as_ref() else {
        return redirect_with_error(&state, "/pricing", "auth_unavailable");
    };
    if ensure_auth_configured(&state).is_err() {
        return redirect_with_error(&state, "/pricing", "auth_unconfigured");
    }
    if query.error.is_some() {
        return redirect_with_error(&state, "/pricing", "auth_cancelled");
    }

    let Some(state_token) = query.state.as_deref() else {
        return redirect_with_error(&state, "/pricing", "auth_state_missing");
    };
    let return_path = match database.consume_oauth_state(state_token, unix_now()).await {
        Ok(Some(return_path)) => return_path,
        Ok(None) => return redirect_with_error(&state, "/pricing", "auth_state_invalid"),
        Err(error) => {
            tracing::error!(error = %error, "Failed to consume OAuth state");
            return redirect_with_error(&state, "/pricing", "auth_failed");
        }
    };

    let Some(code) = query.code.as_deref() else {
        return redirect_with_error(&state, &return_path, "auth_code_missing");
    };

    match finish_google_sign_in(&state, database, code).await {
        Ok(session_token) => {
            let target = app_return_url(&state.config.auth.public_app_url, &return_path);
            let mut response = Redirect::to(&target).into_response();
            match HeaderValue::from_str(&session_cookie(&state, &session_token)) {
                Ok(cookie) => {
                    response.headers_mut().append(SET_COOKIE, cookie);
                    response
                }
                Err(error) => {
                    tracing::error!(error = %error, "Failed to build session cookie");
                    redirect_with_error(&state, &return_path, "auth_failed")
                }
            }
        }
        Err(error) => {
            tracing::error!(error = %error.message, "Google sign-in failed");
            redirect_with_error(&state, &return_path, "auth_failed")
        }
    }
}

pub async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(token) = session_cookie_value(&state, &headers) {
        if let Some(database) = state.cloud_db.as_ref() {
            let token_hash = session_token_hash(&state, &token);
            if let Err(error) = database.revoke_auth_session(&token_hash, unix_now()).await {
                tracing::error!(error = %error, "Failed to revoke auth session");
            }
        }
    }

    let mut response = Json(serde_json::json!({ "ok": true })).into_response();
    if let Ok(cookie) = HeaderValue::from_str(&expired_session_cookie(&state)) {
        response.headers_mut().append(SET_COOKIE, cookie);
    }
    response
}

pub async fn current_session_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<UserIdentity>, AuthError> {
    let Some(user) = current_auth_user(state, headers).await? else {
        return Ok(None);
    };
    Ok(Some(UserIdentity {
        id: user.id,
        email: user.email,
    }))
}

async fn finish_google_sign_in(
    state: &AppState,
    database: &CloudDatabase,
    code: &str,
) -> Result<String, AuthError> {
    let token = exchange_google_code(state, code).await?;
    let profile = verify_google_id_token(state, &token.id_token).await?;
    if !is_email_verified(&profile.email_verified) {
        return Err(AuthError::unauthorized("Google email is not verified"));
    }
    let email = profile
        .email
        .as_deref()
        .ok_or_else(|| AuthError::unauthorized("Google account did not return an email"))?;

    let now = unix_now();
    let user = database
        .upsert_google_user(GoogleUserInput {
            google_sub: &profile.sub,
            email,
            name: profile.name.as_deref(),
            picture_url: profile.picture.as_deref(),
            now,
        })
        .await
        .map_err(AuthError::internal)?;

    let session_token = random_token(32);
    let token_hash = session_token_hash(state, &session_token);
    database
        .insert_auth_session(
            user.id,
            &token_hash,
            now,
            now + state.config.auth.session_ttl_seconds,
        )
        .await
        .map_err(AuthError::internal)?;

    Ok(session_token)
}

async fn exchange_google_code(
    state: &AppState,
    code: &str,
) -> Result<GoogleTokenResponse, AuthError> {
    let redirect_uri = google_redirect_uri(state);
    let response = state
        .http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code),
            ("client_id", state.config.auth.google_client_id.as_str()),
            (
                "client_secret",
                state.config.auth.google_client_secret.as_str(),
            ),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(AuthError::internal)?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|error| format!("failed to read Google error body: {error}"));
        tracing::error!(
            status = %status,
            error_body = %body,
            "Google token exchange failed"
        );
        return Err(AuthError::internal(format!(
            "Google token exchange failed with {status}: {body}"
        )));
    }

    response.json().await.map_err(AuthError::internal)
}

async fn verify_google_id_token(
    state: &AppState,
    id_token: &str,
) -> Result<GoogleTokenInfo, AuthError> {
    let token_info = state
        .http
        .get("https://oauth2.googleapis.com/tokeninfo")
        .query(&[("id_token", id_token)])
        .send()
        .await
        .map_err(AuthError::internal)?
        .error_for_status()
        .map_err(AuthError::internal)?
        .json::<GoogleTokenInfo>()
        .await
        .map_err(AuthError::internal)?;

    if token_info.aud != state.config.auth.google_client_id {
        return Err(AuthError::unauthorized(
            "Google token audience does not match this app",
        ));
    }
    Ok(token_info)
}

async fn current_auth_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<AuthUserRecord>, AuthError> {
    let Some(database) = state.cloud_db.as_ref() else {
        return Ok(None);
    };
    let Some(token) = session_cookie_value(state, headers) else {
        return Ok(None);
    };
    let token_hash = session_token_hash(state, &token);
    database
        .user_for_session(&token_hash, unix_now())
        .await
        .map_err(AuthError::internal)
}

fn ensure_auth_configured(state: &AppState) -> Result<(), AuthError> {
    if state.config.auth.google_client_id.trim().is_empty()
        || state.config.auth.google_client_secret.trim().is_empty()
    {
        return Err(AuthError::unavailable("Google sign-in is not configured"));
    }
    if state.config.auth.session_secret.trim().len() < 32 {
        return Err(AuthError::unavailable(
            "AUTH_SESSION_SECRET must be at least 32 characters",
        ));
    }
    Ok(())
}

fn session_cookie_value(state: &AppState, headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get(COOKIE)?.to_str().ok()?;
    cookie_header.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        if name == state.config.auth.session_cookie_name {
            Some(value.to_string())
        } else {
            None
        }
    })
}

fn session_cookie(state: &AppState, token: &str) -> String {
    let secure = if state.config.auth.public_api_url.starts_with("https://") {
        "; Secure"
    } else {
        ""
    };
    format!(
        "{}={}; Path=/; Max-Age={}; HttpOnly; SameSite=Lax{}",
        state.config.auth.session_cookie_name, token, state.config.auth.session_ttl_seconds, secure
    )
}

fn expired_session_cookie(state: &AppState) -> String {
    let secure = if state.config.auth.public_api_url.starts_with("https://") {
        "; Secure"
    } else {
        ""
    };
    format!(
        "{}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax{}",
        state.config.auth.session_cookie_name, secure
    )
}

fn session_token_hash(state: &AppState, token: &str) -> String {
    let mut mac = HmacSha1::new_from_slice(state.config.auth.session_secret.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(token.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn random_token(bytes: usize) -> String {
    let mut data = vec![0_u8; bytes];
    rand::thread_rng().fill_bytes(&mut data);
    URL_SAFE_NO_PAD.encode(data)
}

fn google_redirect_uri(state: &AppState) -> String {
    state.config.auth.google_redirect_uri.clone()
}

fn safe_return_path(value: Option<&str>) -> String {
    let Some(path) = value else {
        return "/pricing".to_string();
    };
    if path.starts_with('/') && !path.starts_with("//") {
        path.to_string()
    } else {
        "/pricing".to_string()
    }
}

fn redirect_with_error(state: &AppState, return_path: &str, code: &str) -> Response {
    let target = app_return_url(&state.config.auth.public_app_url, return_path);
    let separator = if target.contains('?') { "&" } else { "?" };
    let target = format!("{target}{separator}auth={code}");
    Redirect::to(&target).into_response()
}

fn app_return_url(public_app_url: &str, return_path: &str) -> String {
    let base = public_app_url.trim_end_matches('/');
    if return_path.starts_with('/') {
        format!("{base}{return_path}")
    } else {
        format!("{base}/{return_path}")
    }
}

fn is_email_verified(value: &Value) -> bool {
    match value {
        Value::Bool(value) => *value,
        Value::String(value) => value == "true",
        _ => false,
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl From<AuthUserRecord> for AuthUserResponse {
    fn from(user: AuthUserRecord) -> Self {
        Self {
            id: user.id.to_string(),
            email: user.email,
            name: user.name,
            picture_url: user.picture_url,
        }
    }
}

#[derive(Debug)]
pub struct AuthError {
    status: StatusCode,
    message: String,
}

impl AuthError {
    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(error = %error, "Auth error");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "Auth request failed".to_string(),
        }
    }
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(AuthErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::{app_return_url, safe_return_path};

    #[test]
    fn safe_return_path_accepts_only_relative_app_paths() {
        assert_eq!(safe_return_path(Some("/pricing")), "/pricing");
        assert_eq!(
            safe_return_path(Some("/pricing?plan=pro")),
            "/pricing?plan=pro"
        );
        assert_eq!(safe_return_path(Some("https://evil.example")), "/pricing");
        assert_eq!(safe_return_path(Some("//evil.example")), "/pricing");
        assert_eq!(safe_return_path(None), "/pricing");
    }

    #[test]
    fn app_return_url_targets_frontend_origin() {
        assert_eq!(
            app_return_url("http://localhost:3500", "/pricing?plan=pro"),
            "http://localhost:3500/pricing?plan=pro"
        );
        assert_eq!(
            app_return_url("https://warp.ponslink.com/", "pricing"),
            "https://warp.ponslink.com/pricing"
        );
    }
}
