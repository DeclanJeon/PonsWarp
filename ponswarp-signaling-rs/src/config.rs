//! 환경 변수 기반 설정 관리

use anyhow::{bail, Context, Result};
use axum::http::{
    header::{AUTHORIZATION, CONTENT_TYPE},
    HeaderValue, Method,
};
use std::env;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use std::path::Path;

/// 서버 설정
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub host: String,
    #[allow(dead_code)]
    pub cors_origins: Vec<String>,
    pub lan_evidence_mode: bool,
    pub lan_evidence_ws_origins: Vec<CanonicalOrigin>,
    lan_evidence_mode_error: Option<String>,
    pub database: DatabaseConfig,
    pub auth: AuthConfig,
    pub admin: AdminConfig,
    pub billing: BillingConfig,
    pub room: RoomConfig,
    pub turn: TurnConfig,
    pub cloud: CloudConfig,
    pub mesh: MeshConfig,
    pub log_level: String,
}
/// A strictly canonical origin used by the LAN evidence WebSocket allowlist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalOrigin(String);

impl CanonicalOrigin {
    pub fn parse(value: &str) -> Result<Self> {
        let value = value;
        let prefix = "http://localhost:";
        if !value.starts_with(prefix) {
            bail!("LAN_EVIDENCE_WS_ORIGINS must contain canonical http://localhost:<port> origins");
        }
        let port = &value[prefix.len()..];
        if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
            bail!("LAN_EVIDENCE_WS_ORIGINS contains an invalid localhost port");
        }
        let port: u16 = port
            .parse()
            .context("LAN_EVIDENCE_WS_ORIGINS port is out of range")?;
        if !(1024..=65535).contains(&port) {
            bail!("LAN_EVIDENCE_WS_ORIGINS ports must be in 1024..=65535");
        }
        let canonical = format!("{prefix}{port}");
        if value != canonical {
            bail!("LAN_EVIDENCE_WS_ORIGINS origin is not canonical: {value}");
        }
        Ok(Self(canonical))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 관리자 접근 설정.
#[derive(Debug, Clone)]
pub struct AdminConfig {
    pub bootstrap_emails: Vec<String>,
}

/// Google OAuth and browser session settings.
#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub google_client_id: String,
    pub google_client_secret: String,
    pub google_redirect_uri: String,
    pub session_secret: String,
    pub session_cookie_name: String,
    pub session_ttl_seconds: u64,
    pub public_app_url: String,
    pub public_api_url: String,
}

/// 선택적 Postgres 설정
#[derive(Debug, Clone)]
pub struct DatabaseConfig {
    pub url: String,
    pub max_connections: u32,
    pub run_migrations: bool,
}

/// 결제 provider 설정
#[derive(Debug, Clone)]
pub struct BillingConfig {
    pub default_provider: String,
    pub lemonsqueezy_api_key: String,
    pub lemonsqueezy_api_base: String,
    pub lemonsqueezy_store_id: String,
    pub lemonsqueezy_webhook_secret: String,
    pub lemonsqueezy_variant_drop_100gb_3d: String,
    pub lemonsqueezy_variant_drop_500gb_7d: String,
    pub lemonsqueezy_variant_drop_1tb_7d: String,
    pub lemonsqueezy_variant_pro_monthly: String,
    pub paypal_client_id: String,
    pub paypal_client_secret: String,
    pub paypal_webhook_id: String,
    pub paypal_api_base: String,
    pub paypal_currency: String,
    pub paypal_pro_plan_id: String,
    pub public_app_url: String,
}

/// 방 설정
#[derive(Debug, Clone)]
pub struct RoomConfig {
    pub max_size: usize,
    pub timeout_ms: u64,
}

/// TURN 서버 설정
#[derive(Debug, Clone)]
pub struct TurnConfig {
    pub url: String,
    pub secret: String,
    #[allow(dead_code)]
    pub realm: String,
    pub enable_tls: bool,
    pub enable_udp: bool,
    pub enable_tcp: bool,
    pub ports: TurnPorts,
    pub credential_ttl: u64,
    pub fallback_servers: Vec<String>,
}

/// TURN 포트 설정
#[derive(Debug, Clone)]
pub struct TurnPorts {
    pub udp: u16,
    pub tcp: u16,
    pub tls: u16,
}

/// Cloudflare R2 backed temporary file share 설정
#[derive(Debug, Clone)]
pub struct CloudConfig {
    pub enabled: bool,
    pub billing_enabled: bool,
    pub bucket: String,
    pub endpoint: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub region: String,
    pub prefix: String,
    pub retention_seconds: u64,
    pub upload_url_ttl_seconds: u64,
    pub download_url_ttl_seconds: u64,
    pub cleanup_interval_seconds: u64,
    pub cleanup_run_on_startup: bool,
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
}

/// PonsWarp AI Mesh / Workspace Coordinator settings.
#[derive(Debug, Clone)]
pub struct MeshConfig {
    pub enabled: bool,
    pub storage: MeshStorage,
    pub auto_approve_nodes: bool,
    pub presence_ttl_seconds: u64,
    pub token_pepper: String,
    pub admin_token: String,
    pub rate_limit_capacity: u32,
    pub rate_limit_refill_per_second: u32,
    pub workspace_file_quota: usize,
    pub workspace_share_quota: usize,
    pub expired_share_retention_seconds: u64,
    pub stale_presence_retention_seconds: u64,
    pub event_retention_seconds: u64,
    pub cleanup_interval_seconds: u64,
    pub cleanup_run_on_startup: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshStorage {
    Memory,
    Postgres,
}

impl MeshStorage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::Postgres => "postgres",
        }
    }

    fn from_env_value(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "memory" => Ok(Self::Memory),
            "postgres" => Ok(Self::Postgres),
            other => bail!("PONSWARP_MESH_STORAGE must be memory or postgres, got {other}"),
        }
    }
}

impl Default for MeshConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            storage: MeshStorage::Memory,
            auto_approve_nodes: false,
            presence_ttl_seconds: 60,
            token_pepper: String::new(),
            admin_token: String::new(),
            rate_limit_capacity: 120,
            rate_limit_refill_per_second: 2,
            workspace_file_quota: 1_000,
            workspace_share_quota: 1_000,
            expired_share_retention_seconds: 3_600,
            stale_presence_retention_seconds: 300,
            event_retention_seconds: 86_400,
            cleanup_interval_seconds: 300,
            cleanup_run_on_startup: true,
        }
    }
}

impl Config {
    /// 환경 변수에서 설정 로드
    pub fn from_env() -> Self {
        load_env_files();

        let r2_account_id = env::var("R2_ACCOUNT_ID").unwrap_or_default();
        let r2_endpoint = env::var("R2_ENDPOINT")
            .or_else(|_| env::var("CLOUDFLARE_R2_ENDPOINT"))
            .unwrap_or_else(|_| {
                if r2_account_id.is_empty() {
                    String::new()
                } else {
                    format!("https://{}.r2.cloudflarestorage.com", r2_account_id)
                }
            });
        let r2_bucket = env::var("R2_BUCKET_NAME")
            .or_else(|_| env::var("CLOUDFLARE_R2_BUCKET"))
            .unwrap_or_default();
        let r2_access_key = env::var("R2_ACCESS_KEY_ID")
            .or_else(|_| env::var("CLOUDFLARE_R2_ACCESS_KEY_ID"))
            .unwrap_or_default();
        let r2_secret_key = env::var("R2_SECRET_ACCESS_KEY")
            .or_else(|_| env::var("CLOUDFLARE_R2_SECRET_ACCESS_KEY"))
            .unwrap_or_default();
        let cloud_enabled = env::var("PONSWARP_CLOUD_ENABLED")
            .map(|v| v != "false")
            .unwrap_or_else(|_| {
                !r2_endpoint.is_empty()
                    && !r2_bucket.is_empty()
                    && !r2_access_key.is_empty()
                    && !r2_secret_key.is_empty()
            });
        let lan_evidence_mode_error =
            env::var("LAN_EVIDENCE_MODE")
                .ok()
                .and_then(|value| match value.as_str() {
                    "true" | "false" => None,
                    _ => Some(format!(
                        "LAN_EVIDENCE_MODE must be exactly true or false, got {value:?}"
                    )),
                });
        let lan_evidence_mode = env::var("LAN_EVIDENCE_MODE")
            .map(|value| value == "true")
            .unwrap_or(false);
        let lan_evidence_ws_origins = if lan_evidence_mode {
            env::var("LAN_EVIDENCE_WS_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .filter(|origin| !origin.trim().is_empty())
                .map(|origin| {
                    CanonicalOrigin::parse(origin).unwrap_or_else(|error| panic!("{error}"))
                })
                .collect()
        } else {
            Vec::new()
        };

        Self {
            port: env::var("PORT")
                .unwrap_or_else(|_| "5502".to_string())
                .parse()
                .unwrap_or(5502),
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            cors_origins: env::var("CORS_ORIGINS")
                .unwrap_or_else(|_| "http://localhost:3500".to_string())
                .split(',')
                .map(|s| s.trim().to_string())
                .collect(),
            lan_evidence_mode,
            lan_evidence_ws_origins,
            lan_evidence_mode_error,
            database: DatabaseConfig {
                url: env::var("DATABASE_URL")
                    .or_else(|_| env::var("POSTGRES_URL"))
                    .unwrap_or_default(),
                max_connections: env::var("DATABASE_MAX_CONNECTIONS")
                    .unwrap_or_else(|_| "5".to_string())
                    .parse()
                    .unwrap_or(5),
                run_migrations: env::var("DATABASE_RUN_MIGRATIONS")
                    .map(|v| v != "false")
                    .unwrap_or(true),
            },
            mesh: MeshConfig {
                enabled: env::var("PONSWARP_MESH_ENABLED")
                    .map(|v| v == "true")
                    .unwrap_or(false),
                storage: env::var("PONSWARP_MESH_STORAGE")
                    .map(|value| MeshStorage::from_env_value(&value))
                    .unwrap_or(Ok(MeshStorage::Memory))
                    .unwrap_or_else(|err| panic!("{err}")),
                auto_approve_nodes: env::var("PONSWARP_MESH_AUTO_APPROVE_NODES")
                    .map(|v| v == "true")
                    .unwrap_or(false),
                presence_ttl_seconds: env::var("PONSWARP_MESH_PRESENCE_TTL_SECONDS")
                    .unwrap_or_else(|_| "60".to_string())
                    .parse()
                    .unwrap_or(60),
                token_pepper: env::var("PONSWARP_MESH_TOKEN_PEPPER").unwrap_or_default(),
                admin_token: env::var("PONSWARP_MESH_ADMIN_TOKEN").unwrap_or_default(),
                rate_limit_capacity: env::var("PONSWARP_MESH_RATE_LIMIT_CAPACITY")
                    .unwrap_or_else(|_| "120".to_string())
                    .parse()
                    .unwrap_or(120),
                rate_limit_refill_per_second: env::var(
                    "PONSWARP_MESH_RATE_LIMIT_REFILL_PER_SECOND",
                )
                .unwrap_or_else(|_| "2".to_string())
                .parse()
                .unwrap_or(2),
                workspace_file_quota: env::var("PONSWARP_MESH_WORKSPACE_FILE_QUOTA")
                    .unwrap_or_else(|_| "1000".to_string())
                    .parse()
                    .unwrap_or(1_000),
                workspace_share_quota: env::var("PONSWARP_MESH_WORKSPACE_SHARE_QUOTA")
                    .unwrap_or_else(|_| "1000".to_string())
                    .parse()
                    .unwrap_or(1_000),
                expired_share_retention_seconds: parse_env_u64(
                    env::var("PONSWARP_MESH_EXPIRED_SHARE_RETENTION_SECONDS"),
                    3_600,
                ),
                stale_presence_retention_seconds: parse_env_u64(
                    env::var("PONSWARP_MESH_STALE_PRESENCE_RETENTION_SECONDS"),
                    300,
                ),
                event_retention_seconds: parse_env_u64(
                    env::var("PONSWARP_MESH_EVENT_RETENTION_SECONDS"),
                    86_400,
                ),
                cleanup_interval_seconds: parse_env_u64(
                    env::var("PONSWARP_MESH_CLEANUP_INTERVAL_SECONDS"),
                    300,
                ),
                cleanup_run_on_startup: parse_env_bool_default_true(env::var(
                    "PONSWARP_MESH_CLEANUP_RUN_ON_STARTUP",
                )),
            },
            auth: AuthConfig {
                google_client_id: env::var("GOOGLE_CLIENT_ID")
                    .or_else(|_| env::var("GOOGLE_OAUTH_CLIENT_ID"))
                    .unwrap_or_default(),
                google_client_secret: env::var("GOOGLE_CLIENT_SECRET")
                    .or_else(|_| env::var("GOOGLE_OAUTH_CLIENT_SECRET"))
                    .unwrap_or_default(),
                session_secret: env::var("AUTH_SESSION_SECRET").unwrap_or_default(),
                session_cookie_name: env::var("AUTH_SESSION_COOKIE_NAME")
                    .unwrap_or_else(|_| "ponswarp_session".to_string()),
                session_ttl_seconds: env::var("AUTH_SESSION_TTL_SECONDS")
                    .unwrap_or_else(|_| "2592000".to_string())
                    .parse()
                    .unwrap_or(30 * 24 * 60 * 60),
                public_app_url: env::var("PONSWARP_PUBLIC_APP_URL")
                    .or_else(|_| env::var("PONSWARP_PUBLIC_API_URL"))
                    .unwrap_or_else(|_| "https://warp.ponslink.com".to_string()),
                public_api_url: env::var("PONSWARP_PUBLIC_API_URL")
                    .or_else(|_| env::var("PONSWARP_PUBLIC_APP_URL"))
                    .unwrap_or_else(|_| "https://warp.ponslink.com".to_string()),
                google_redirect_uri: env::var("GOOGLE_REDIRECT_URI").unwrap_or_else(|_| {
                    let public_api_url = env::var("PONSWARP_PUBLIC_API_URL")
                        .or_else(|_| env::var("PONSWARP_PUBLIC_APP_URL"))
                        .unwrap_or_else(|_| "https://warp.ponslink.com".to_string());
                    format!(
                        "{}/auth/google/callback",
                        public_api_url.trim_end_matches('/')
                    )
                }),
            },
            admin: AdminConfig {
                bootstrap_emails: env::var("ADMIN_BOOTSTRAP_EMAILS")
                    .unwrap_or_default()
                    .split(',')
                    .filter_map(|email| {
                        let email = email.trim().to_lowercase();
                        if email.is_empty() {
                            None
                        } else {
                            Some(email)
                        }
                    })
                    .collect(),
            },
            billing: BillingConfig {
                default_provider: env::var("PONSWARP_DEFAULT_PAYMENT_PROVIDER")
                    .unwrap_or_else(|_| "lemonsqueezy".to_string())
                    .to_lowercase(),
                lemonsqueezy_api_key: env::var("LEMONSQUEEZY_API_KEY").unwrap_or_default(),
                lemonsqueezy_api_base: env::var("LEMONSQUEEZY_API_BASE")
                    .unwrap_or_else(|_| "https://api.lemonsqueezy.com".to_string()),
                lemonsqueezy_store_id: env::var("LEMONSQUEEZY_STORE_ID").unwrap_or_default(),
                lemonsqueezy_webhook_secret: env::var("LEMONSQUEEZY_WEBHOOK_SECRET")
                    .unwrap_or_default(),
                lemonsqueezy_variant_drop_100gb_3d: env::var("LEMONSQUEEZY_VARIANT_DROP_100GB_3D")
                    .unwrap_or_default(),
                lemonsqueezy_variant_drop_500gb_7d: env::var("LEMONSQUEEZY_VARIANT_DROP_500GB_7D")
                    .unwrap_or_default(),
                lemonsqueezy_variant_drop_1tb_7d: env::var("LEMONSQUEEZY_VARIANT_DROP_1TB_7D")
                    .unwrap_or_default(),
                lemonsqueezy_variant_pro_monthly: env::var("LEMONSQUEEZY_VARIANT_PRO_MONTHLY")
                    .unwrap_or_default(),
                paypal_client_id: env::var("PAYPAL_CLIENT_ID").unwrap_or_default(),
                paypal_client_secret: env::var("PAYPAL_CLIENT_SECRET").unwrap_or_default(),
                paypal_webhook_id: env::var("PAYPAL_WEBHOOK_ID").unwrap_or_default(),
                paypal_api_base: env::var("PAYPAL_API_BASE").unwrap_or_else(|_| {
                    match env::var("PAYPAL_ENV").unwrap_or_default().as_str() {
                        "sandbox" => "https://api-m.sandbox.paypal.com".to_string(),
                        _ => "https://api-m.paypal.com".to_string(),
                    }
                }),
                paypal_currency: env::var("PAYPAL_DEFAULT_CURRENCY")
                    .unwrap_or_else(|_| "KRW".to_string()),
                paypal_pro_plan_id: env::var("PAYPAL_PRO_PLAN_ID").unwrap_or_default(),
                public_app_url: env::var("PONSWARP_PUBLIC_APP_URL")
                    .unwrap_or_else(|_| "https://warp.ponslink.com".to_string()),
            },
            room: RoomConfig {
                max_size: env::var("MAX_ROOM_SIZE")
                    .unwrap_or_else(|_| "4".to_string())
                    .parse()
                    .unwrap_or(4),
                timeout_ms: env::var("ROOM_TIMEOUT")
                    .unwrap_or_else(|_| "3600000".to_string())
                    .parse()
                    .unwrap_or(3600000),
            },
            turn: TurnConfig {
                url: env::var("TURN_SERVER_URL").unwrap_or_default(),
                secret: env::var("TURN_SECRET").unwrap_or_default(),
                realm: env::var("TURN_REALM").unwrap_or_default(),
                enable_tls: env::var("TURN_ENABLE_TLS")
                    .map(|v| v == "true")
                    .unwrap_or(false),
                enable_udp: env::var("TURN_ENABLE_UDP")
                    .map(|v| v != "false")
                    .unwrap_or(true),
                enable_tcp: env::var("TURN_ENABLE_TCP")
                    .map(|v| v != "false")
                    .unwrap_or(true),
                ports: TurnPorts {
                    udp: env::var("TURN_PORT_UDP")
                        .unwrap_or_else(|_| "3478".to_string())
                        .parse()
                        .unwrap_or(3478),
                    tcp: env::var("TURN_PORT_TCP")
                        .unwrap_or_else(|_| "3478".to_string())
                        .parse()
                        .unwrap_or(3478),
                    tls: env::var("TURN_PORT_TLS")
                        .unwrap_or_else(|_| "443".to_string())
                        .parse()
                        .unwrap_or(443),
                },
                credential_ttl: env::var("TURN_CREDENTIAL_TTL")
                    .unwrap_or_else(|_| "3600".to_string())
                    .parse()
                    .unwrap_or(3600),
                fallback_servers: env::var("TURN_FALLBACK_SERVERS")
                    .unwrap_or_default()
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(|s| s.trim().to_string())
                    .collect(),
            },
            cloud: CloudConfig {
                enabled: cloud_enabled,
                billing_enabled: env::var("PONSWARP_BILLING_ENABLED")
                    .map(|v| v == "true")
                    .unwrap_or(false),
                bucket: r2_bucket,
                endpoint: r2_endpoint,
                access_key_id: r2_access_key,
                secret_access_key: r2_secret_key,
                region: env::var("R2_REGION")
                    .or_else(|_| env::var("CLOUDFLARE_R2_REGION"))
                    .unwrap_or_else(|_| "auto".to_string()),
                prefix: env::var("PONSWARP_CLOUD_PREFIX")
                    .unwrap_or_else(|_| "ponswarp-cloud".to_string()),
                retention_seconds: env::var("PONSWARP_CLOUD_RETENTION_SECONDS")
                    .unwrap_or_else(|_| "86400".to_string())
                    .parse()
                    .unwrap_or(86400),
                upload_url_ttl_seconds: env::var("PONSWARP_CLOUD_UPLOAD_URL_TTL_SECONDS")
                    .or_else(|_| env::var("R2_SIGNED_URL_TTL_SECONDS"))
                    .unwrap_or_else(|_| "3600".to_string())
                    .parse()
                    .unwrap_or(3600),
                download_url_ttl_seconds: env::var("PONSWARP_CLOUD_DOWNLOAD_URL_TTL_SECONDS")
                    .unwrap_or_else(|_| "300".to_string())
                    .parse()
                    .unwrap_or(300),
                cleanup_interval_seconds: env::var("PONSWARP_CLOUD_CLEANUP_INTERVAL_SECONDS")
                    .unwrap_or_else(|_| "300".to_string())
                    .parse()
                    .unwrap_or(300),
                cleanup_run_on_startup: env::var("PONSWARP_CLOUD_CLEANUP_RUN_ON_STARTUP")
                    .or_else(|_| env::var("R2_CLEANUP_RUN_ON_STARTUP"))
                    .map(|v| v != "false")
                    .unwrap_or(true),
                max_files: env::var("PONSWARP_CLOUD_MAX_FILES")
                    .unwrap_or_else(|_| "100".to_string())
                    .parse()
                    .unwrap_or(100),
                max_file_bytes: env::var("PONSWARP_CLOUD_MAX_FILE_BYTES")
                    .unwrap_or_else(|_| "10737418240".to_string())
                    .parse()
                    .unwrap_or(10 * 1024 * 1024 * 1024),
                max_total_bytes: env::var("PONSWARP_CLOUD_MAX_TOTAL_BYTES")
                    .unwrap_or_else(|_| "10737418240".to_string())
                    .parse()
                    .unwrap_or(10 * 1024 * 1024 * 1024),
            },
            log_level: env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string()),
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.mesh.enabled
            && self.mesh.storage == MeshStorage::Postgres
            && self.database.url.trim().is_empty()
        {
            bail!("PONSWARP_MESH_ENABLED=true with PONSWARP_MESH_STORAGE=postgres requires DATABASE_URL or POSTGRES_URL");
        }
        if self.mesh.enabled
            && self.mesh.storage == MeshStorage::Postgres
            && self.mesh.token_pepper.trim().len() < 32
        {
            bail!("PONSWARP_MESH_ENABLED=true with PONSWARP_MESH_STORAGE=postgres requires PONSWARP_MESH_TOKEN_PEPPER with at least 32 characters");
        }
        if self.mesh.enabled
            && self.mesh.storage == MeshStorage::Postgres
            && self.mesh.admin_token.trim().len() < 32
        {
            bail!("PONSWARP_MESH_ENABLED=true with PONSWARP_MESH_STORAGE=postgres requires PONSWARP_MESH_ADMIN_TOKEN with at least 32 characters");
        }
        if let Some(error) = &self.lan_evidence_mode_error {
            bail!("{error}");
        }
        if self.lan_evidence_mode {
            validate_evidence_origins(&self.lan_evidence_ws_origins)?;
        }
        Ok(())
    }
}

#[cfg(test)]
impl Config {
    pub fn from_env_with_mesh(mesh: MeshConfig) -> Self {
        let mut config = Self::from_env();
        config.mesh = mesh;
        config
    }

    pub fn minimal_for_test() -> Self {
        Self {
            port: 5502,
            host: "127.0.0.1".into(),
            cors_origins: vec![],
            lan_evidence_mode: false,
            lan_evidence_ws_origins: vec![],
            lan_evidence_mode_error: None,
            database: DatabaseConfig {
                url: String::new(),
                max_connections: 5,
                run_migrations: false,
            },
            auth: AuthConfig {
                google_client_id: String::new(),
                google_client_secret: String::new(),
                google_redirect_uri: String::new(),
                session_secret: String::new(),
                session_cookie_name: "ponswarp_session".into(),
                session_ttl_seconds: 60,
                public_app_url: String::new(),
                public_api_url: String::new(),
            },
            admin: AdminConfig {
                bootstrap_emails: vec![],
            },
            billing: BillingConfig {
                default_provider: "lemonsqueezy".into(),
                lemonsqueezy_api_key: String::new(),
                lemonsqueezy_api_base: String::new(),
                lemonsqueezy_store_id: String::new(),
                lemonsqueezy_webhook_secret: String::new(),
                lemonsqueezy_variant_drop_100gb_3d: String::new(),
                lemonsqueezy_variant_drop_500gb_7d: String::new(),
                lemonsqueezy_variant_drop_1tb_7d: String::new(),
                lemonsqueezy_variant_pro_monthly: String::new(),
                paypal_client_id: String::new(),
                paypal_client_secret: String::new(),
                paypal_webhook_id: String::new(),
                paypal_api_base: String::new(),
                paypal_currency: "USD".into(),
                paypal_pro_plan_id: String::new(),
                public_app_url: String::new(),
            },
            room: RoomConfig {
                max_size: 10,
                timeout_ms: 1000,
            },
            turn: TurnConfig {
                url: String::new(),
                secret: String::new(),
                realm: String::new(),
                enable_tls: false,
                enable_udp: true,
                enable_tcp: true,
                ports: TurnPorts {
                    udp: 3478,
                    tcp: 3478,
                    tls: 5349,
                },
                credential_ttl: 3600,
                fallback_servers: vec![],
            },
            cloud: CloudConfig {
                enabled: false,
                billing_enabled: false,
                bucket: String::new(),
                endpoint: String::new(),
                access_key_id: String::new(),
                secret_access_key: String::new(),
                region: "auto".into(),
                prefix: String::new(),
                retention_seconds: 60,
                upload_url_ttl_seconds: 60,
                download_url_ttl_seconds: 60,
                cleanup_interval_seconds: 60,
                cleanup_run_on_startup: false,
                max_files: 1,
                max_file_bytes: 1,
                max_total_bytes: 1,
            },
            mesh: MeshConfig::default(),
            log_level: "info".into(),
        }
    }
}

fn load_env_files() {
    dotenvy::from_filename(".env").ok();

    if let Ok(env_file) = env::var("PONSWARP_ENV_FILE") {
        dotenvy::from_filename_override(env_file).ok();
        return;
    }

    let app_env = env::var("PONSWARP_ENV")
        .or_else(|_| env::var("APP_ENV"))
        .unwrap_or_else(|_| "local".to_string());

    load_env_file_if_exists(&format!(".env.{app_env}"));
    load_env_file_if_exists(&format!(".env.{app_env}.local"));

    if app_env == "local" || app_env == "development" {
        load_env_file_if_exists(".env.local");
    }
}

fn load_env_file_if_exists(path: &str) {
    if Path::new(path).exists() {
        dotenvy::from_filename_override(path).ok();
    }
}

fn parse_env_u64(value: std::result::Result<String, env::VarError>, default: u64) -> u64 {
    value
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn parse_env_bool_default_true(value: std::result::Result<String, env::VarError>) -> bool {
    value
        .map(|value| !value.trim().eq_ignore_ascii_case("false"))
        .unwrap_or(true)
}

pub fn cors_layer(config: &Config) -> Result<CorsLayer> {
    let origins = config
        .cors_origins
        .iter()
        .filter(|origin| !origin.trim().is_empty())
        .collect::<Vec<_>>();

    let layer = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([CONTENT_TYPE, AUTHORIZATION]);
    if origins.iter().any(|origin| origin.trim() == "*") {
        return Ok(layer.allow_origin(Any));
    }

    let parsed = origins
        .into_iter()
        .map(|origin| {
            origin
                .parse::<HeaderValue>()
                .with_context(|| format!("invalid CORS origin: {origin}"))
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(layer
        .allow_origin(AllowOrigin::list(parsed))
        .allow_credentials(true))
}

fn validate_evidence_origins(origins: &[CanonicalOrigin]) -> Result<()> {
    if origins.len() != 2 {
        bail!("LAN_EVIDENCE_WS_ORIGINS must contain exactly two origins");
    }
    if origins[0] == origins[1] {
        bail!("LAN_EVIDENCE_WS_ORIGINS origins must be unique");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_origin_parser_accepts_only_canonical_localhost_origins() {
        assert!(CanonicalOrigin::parse("http://localhost:4173").is_ok());
        for invalid in [
            "http://localhost:4173/",
            "https://localhost:4173",
            "http://127.0.0.1:4173",
            "http://localhost:80",
            "http://localhost:4173?x=1",
            "*",
        ] {
            assert!(CanonicalOrigin::parse(invalid).is_err(), "{invalid}");
        }
    }
    #[test]
    fn evidence_mode_value_validation_rejects_typos() {
        let mut config = Config::minimal_for_test();
        config.lan_evidence_mode_error = Some("invalid".into());
        assert!(config.validate().is_err());
        config.lan_evidence_mode_error = None;
        assert!(config.validate().is_ok());
    }

    #[test]
    fn evidence_origin_validation_requires_two_unique_origins() {
        let first = CanonicalOrigin::parse("http://localhost:4173").unwrap();
        let second = CanonicalOrigin::parse("http://localhost:4174").unwrap();
        assert!(validate_evidence_origins(&[first.clone(), second]).is_ok());
        assert!(validate_evidence_origins(&[]).is_err());
        assert!(validate_evidence_origins(&[first.clone()]).is_err());
        assert!(validate_evidence_origins(&[first.clone(), first]).is_err());
    }
    #[test]
    fn mesh_defaults_are_disabled_without_environment_dependency() {
        let mesh = MeshConfig::default();
        assert!(!mesh.enabled);
        assert_eq!(mesh.storage, MeshStorage::Memory);
    }
    #[test]
    fn default_mesh_config_is_process_separation_safe() {
        let mesh = MeshConfig::default();
        assert!(!mesh.enabled);
        assert_eq!(mesh.presence_ttl_seconds, 60);
        assert!(!mesh.auto_approve_nodes);
    }

    #[test]
    fn mesh_cleanup_env_helpers_parse_defaults_overrides_and_invalid_values() {
        assert_eq!(parse_env_u64(Err(env::VarError::NotPresent), 300), 300);
        assert_eq!(parse_env_u64(Ok("42".to_string()), 300), 42);
        assert_eq!(parse_env_u64(Ok("bad".to_string()), 300), 300);
        assert!(parse_env_bool_default_true(Err(env::VarError::NotPresent)));
        assert!(!parse_env_bool_default_true(Ok("false".to_string())));
        assert!(!parse_env_bool_default_true(Ok(" FALSE ".to_string())));
        assert!(parse_env_bool_default_true(Ok("true".to_string())));
    }

    #[test]
    fn mesh_disabled_allows_postgres_storage_without_database_url() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = false;
        config.mesh.storage = MeshStorage::Postgres;
        assert!(config.validate().is_ok());
    }

    #[test]
    fn mesh_enabled_postgres_requires_database_url() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.storage = MeshStorage::Postgres;
        let err = config.validate().unwrap_err().to_string();
        assert!(err.contains("DATABASE_URL"));
    }

    #[test]
    fn mesh_enabled_memory_does_not_require_database_url() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.storage = MeshStorage::Memory;
        config.mesh.token_pepper = String::new();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn mesh_enabled_postgres_requires_token_pepper() {
        let mut config = Config::minimal_for_test();
        config.mesh.enabled = true;
        config.mesh.storage = MeshStorage::Postgres;
        config.database.url = "postgres://example.invalid/ponswarp".into();
        let err = config.validate().unwrap_err().to_string();
        assert!(err.contains("PONSWARP_MESH_TOKEN_PEPPER"));
        config.mesh.token_pepper = "0123456789abcdef0123456789abcdef".into();
        config.mesh.admin_token = "0123456789abcdef0123456789abcdef".into();
        assert!(config.validate().is_ok());
    }
}
