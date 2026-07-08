use axum::http::{HeaderMap, HeaderValue};
use futures::future::{BoxFuture, FutureExt};
use dashmap::DashMap;
use serde_json::{json, Map, Value};
use sqlx::{PgPool, Row};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct MeshAbuseConfig {
    pub rate_limit_capacity: u32,
    pub rate_limit_refill_per_second: u32,
    pub workspace_file_quota: usize,
    pub workspace_share_quota: usize,
}

impl Default for MeshAbuseConfig {
    fn default() -> Self {
        Self {
            rate_limit_capacity: 120,
            rate_limit_refill_per_second: 2,
            workspace_file_quota: 1_000,
            workspace_share_quota: 1_000,
        }
    }
}

pub trait RateLimiter: Send + Sync {
    fn check<'a>(&'a self, key: &'a str, now_seconds: u64) -> BoxFuture<'a, RateLimitOutcome>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RateLimitOutcome {
    Allowed {
        limit: u32,
        remaining: u32,
        reset_seconds: u64,
    },
    Limited {
        limit: u32,
        remaining: u32,
        retry_after_seconds: u64,
        reset_seconds: u64,
    },
    StorageUnavailable {
        limit: u32,
        retry_after_seconds: u64,
    },
}

#[derive(Debug)]
struct Bucket {
    tokens: u32,
    updated_at: u64,
}

#[derive(Debug)]
pub struct InMemoryTokenBucketRateLimiter {
    capacity: u32,
    refill_per_second: u32,
    buckets: DashMap<String, Bucket>,
}

impl InMemoryTokenBucketRateLimiter {
    pub fn new(capacity: u32, refill_per_second: u32) -> Self {
        Self {
            capacity: capacity.max(1),
            refill_per_second: refill_per_second.max(1),
            buckets: DashMap::new(),
        }
    }
}

impl RateLimiter for InMemoryTokenBucketRateLimiter {
    fn check<'a>(&'a self, key: &'a str, now_seconds: u64) -> BoxFuture<'a, RateLimitOutcome> {
        async move {
            let mut bucket = self.buckets.entry(key.to_string()).or_insert(Bucket {
                tokens: self.capacity,
                updated_at: now_seconds,
            });
            let elapsed = now_seconds.saturating_sub(bucket.updated_at);
            if elapsed > 0 {
                let refill = elapsed
                    .saturating_mul(self.refill_per_second as u64)
                    .min(u32::MAX as u64) as u32;
                bucket.tokens = self.capacity.min(bucket.tokens.saturating_add(refill));
                bucket.updated_at = now_seconds;
            }
            let reset_seconds =
                now_seconds + seconds_until_full(bucket.tokens, self.capacity, self.refill_per_second);
            if bucket.tokens == 0 {
                return RateLimitOutcome::Limited {
                    limit: self.capacity,
                    remaining: 0,
                    retry_after_seconds: seconds_per_token(self.refill_per_second),
                    reset_seconds,
                };
            }
            bucket.tokens -= 1;
            RateLimitOutcome::Allowed {
                limit: self.capacity,
                remaining: bucket.tokens,
                reset_seconds,
            }
        }
        .boxed()
    }
}

#[derive(Debug, Clone)]
pub struct PostgresTokenBucketRateLimiter {
    pool: PgPool,
    capacity: u32,
    refill_per_second: u32,
    ttl_seconds: u64,
    cleanup_expired: bool,
}

impl PostgresTokenBucketRateLimiter {
    pub fn new(pool: PgPool, capacity: u32, refill_per_second: u32) -> Self {
        Self {
            pool,
            capacity: capacity.max(1),
            refill_per_second: refill_per_second.max(1),
            ttl_seconds: 86_400,
            cleanup_expired: true,
        }
    }

    pub fn with_cleanup(mut self, cleanup_expired: bool) -> Self {
        self.cleanup_expired = cleanup_expired;
        self
    }
}

const POSTGRES_TOKEN_BUCKET_CLEANUP_SQL: &str = "DELETE FROM mesh_rate_limits WHERE expires_at <= $1";

const POSTGRES_TOKEN_BUCKET_UPSERT_SQL: &str = r#"
                INSERT INTO mesh_rate_limits
                    (bucket_key, tokens, capacity, refill_per_second, updated_at, expires_at)
                VALUES ($1, GREATEST(0, $2 - 1), $2, $3, $4, $4 + $5)
                ON CONFLICT (bucket_key) DO UPDATE SET
                    tokens = GREATEST(
                        0,
                        LEAST(mesh_rate_limits.capacity, mesh_rate_limits.tokens + GREATEST(0, $4 - mesh_rate_limits.updated_at) * mesh_rate_limits.refill_per_second) - 1
                    ),
                    capacity = EXCLUDED.capacity,
                    refill_per_second = EXCLUDED.refill_per_second,
                    updated_at = EXCLUDED.updated_at,
                    expires_at = EXCLUDED.expires_at
                WHERE LEAST(mesh_rate_limits.capacity, mesh_rate_limits.tokens + GREATEST(0, $4 - mesh_rate_limits.updated_at) * mesh_rate_limits.refill_per_second) >= 1
                RETURNING tokens
                "#;

impl RateLimiter for PostgresTokenBucketRateLimiter {
    fn check<'a>(&'a self, key: &'a str, now_seconds: u64) -> BoxFuture<'a, RateLimitOutcome> {
        async move {
            let now = now_seconds.min(i64::MAX as u64) as i64;
            let capacity = self.capacity as f64;
            let refill_per_second = self.refill_per_second as f64;
            let ttl_seconds = self.ttl_seconds.min(i64::MAX as u64) as i64;
            if self.cleanup_expired {
                if sqlx::query(POSTGRES_TOKEN_BUCKET_CLEANUP_SQL)
                    .bind(now)
                    .execute(&self.pool)
                    .await
                    .is_err()
                {
                    return RateLimitOutcome::StorageUnavailable {
                        limit: self.capacity,
                        retry_after_seconds: seconds_per_token(self.refill_per_second),
                    };
                }
            }

            let row = sqlx::query(
                POSTGRES_TOKEN_BUCKET_UPSERT_SQL
            )
            .bind(key)
            .bind(capacity)
            .bind(refill_per_second)
            .bind(now)
            .bind(ttl_seconds)
            .fetch_optional(&self.pool)
            .await;

            let row = match row {
                Ok(Some(row)) => row,
                Ok(None) => {
                    return RateLimitOutcome::Limited {
                        limit: self.capacity,
                        remaining: 0,
                        retry_after_seconds: seconds_per_token(self.refill_per_second),
                        reset_seconds: now_seconds + seconds_until_full(0, self.capacity, self.refill_per_second),
                    };
                }
                Err(_) => {
                    return RateLimitOutcome::StorageUnavailable {
                        limit: self.capacity,
                        retry_after_seconds: seconds_per_token(self.refill_per_second),
                    };
                }
            };

            let remaining_tokens = row.try_get::<f64, _>("tokens").unwrap_or(0.0).floor().max(0.0);

            RateLimitOutcome::Allowed {
                limit: self.capacity,
                remaining: remaining_tokens.min(u32::MAX as f64) as u32,
                reset_seconds: now_seconds
                    + seconds_until_full(
                        remaining_tokens.min(u32::MAX as f64) as u32,
                        self.capacity,
                        self.refill_per_second,
                    ),
            }
        }
        .boxed()
    }
}

fn seconds_per_token(refill_per_second: u32) -> u64 {
    if refill_per_second == 0 {
        1
    } else {
        (1.0 / refill_per_second as f64).ceil().max(1.0) as u64
    }
}

fn seconds_until_full(tokens: u32, capacity: u32, refill_per_second: u32) -> u64 {
    if tokens >= capacity {
        0
    } else {
        ((capacity - tokens) as f64 / refill_per_second.max(1) as f64).ceil() as u64
    }
}

#[derive(Debug, Default)]
pub struct MeshMetrics {
    rate_limited_requests: AtomicU64,
    quota_rejections: AtomicU64,
    abuse_events: AtomicU64,
    request_ids_issued: AtomicU64,
    rate_limit_storage_failures: AtomicU64,
}

impl MeshMetrics {
    pub fn record_rate_limited(&self) {
        self.rate_limited_requests.fetch_add(1, Ordering::Relaxed);
        self.record_abuse_event();
    }

    pub fn record_rate_limit_storage_failure(&self) {
        self.rate_limit_storage_failures.fetch_add(1, Ordering::Relaxed);
        self.record_abuse_event();
    }

    pub fn record_quota_rejection(&self) {
        self.quota_rejections.fetch_add(1, Ordering::Relaxed);
        self.record_abuse_event();
    }

    pub fn record_abuse_event(&self) {
        self.abuse_events.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_request_id_issued(&self) {
        self.request_ids_issued.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> MeshMetricsSnapshot {
        MeshMetricsSnapshot {
            rate_limited_requests: self.rate_limited_requests.load(Ordering::Relaxed),
            quota_rejections: self.quota_rejections.load(Ordering::Relaxed),
            abuse_events: self.abuse_events.load(Ordering::Relaxed),
            request_ids_issued: self.request_ids_issued.load(Ordering::Relaxed),
            rate_limit_storage_failures: self.rate_limit_storage_failures.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MeshMetricsSnapshot {
    pub rate_limited_requests: u64,
    pub rate_limit_storage_failures: u64,
    pub quota_rejections: u64,
    pub abuse_events: u64,
    pub request_ids_issued: u64,
}

pub fn request_id_from_headers(headers: &HeaderMap, metrics: &MeshMetrics) -> String {
    if let Some(value) = headers.get("x-request-id").and_then(safe_header_value) {
        return value;
    }
    metrics.record_request_id_issued();
    format!("req_{}", uuid::Uuid::new_v4().simple())
}

fn safe_header_value(value: &HeaderValue) -> Option<String> {
    let value = value.to_str().ok()?.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    Some(value.to_string())
}

pub fn redact_mesh_log_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| {
                    if is_sensitive_key(key) {
                        (key.clone(), Value::String("[REDACTED]".to_string()))
                    } else {
                        (key.clone(), redact_mesh_log_value(value))
                    }
                })
                .collect::<Map<_, _>>(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(redact_mesh_log_value).collect()),
        _ => value.clone(),
    }
}

pub fn abuse_event(
    event_type: &str,
    request_id: &str,
    subject: &str,
    reason: &str,
    details: Value,
) -> Value {
    json!({
        "eventType": event_type,
        "requestId": request_id,
        "subject": subject,
        "reason": reason,
        "details": redact_mesh_log_value(&details),
        "createdAt": now_seconds()
    })
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("token")
        || key.contains("secret")
        || key.contains("authorization")
        || key == "code"
        || key.contains("sharecode")
        || key.contains("share_code")
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn token_bucket_limits_and_refills() {
        let limiter = InMemoryTokenBucketRateLimiter::new(2, 1);
        assert_eq!(
            limiter.check("a", 10).await,
            RateLimitOutcome::Allowed {
                limit: 2,
                remaining: 1,
                reset_seconds: 10
            }
        );
        assert_eq!(
            limiter.check("a", 10).await,
            RateLimitOutcome::Allowed {
                limit: 2,
                remaining: 0,
                reset_seconds: 11
            }
        );
        assert_eq!(
            limiter.check("a", 10).await,
            RateLimitOutcome::Limited {
                limit: 2,
                remaining: 0,
                retry_after_seconds: 1,
                reset_seconds: 12
            }
        );
        assert_eq!(
            limiter.check("a", 11).await,
            RateLimitOutcome::Allowed {
                limit: 2,
                remaining: 0,
                reset_seconds: 12
            }
        );
    }

    #[test]
    fn redaction_removes_tokens_and_share_codes() {
        let raw = json!({
            "nodeToken": "pwnode_raw",
            "shareCode": "ABCD-EFGH",
            "nested": { "authorization": "Bearer raw", "safe": "kept" }
        });
        let redacted = redact_mesh_log_value(&raw);
        let text = serde_json::to_string(&redacted).unwrap();
        assert!(!text.contains("pwnode_raw"));
        assert!(!text.contains("ABCD-EFGH"));
        assert!(!text.contains("Bearer raw"));
        assert!(text.contains("kept"));
    }

    #[test]
    fn postgres_token_bucket_sql_persists_and_consumes_atomically() {
        assert!(POSTGRES_TOKEN_BUCKET_UPSERT_SQL.contains("mesh_rate_limits"));
        assert!(POSTGRES_TOKEN_BUCKET_UPSERT_SQL.contains("ON CONFLICT"));
        assert!(POSTGRES_TOKEN_BUCKET_UPSERT_SQL.contains("RETURNING tokens"));
        assert!(POSTGRES_TOKEN_BUCKET_UPSERT_SQL.contains("- 1"));
        assert!(POSTGRES_TOKEN_BUCKET_UPSERT_SQL.contains("WHERE LEAST"));
        assert!(POSTGRES_TOKEN_BUCKET_UPSERT_SQL.contains("ON CONFLICT (bucket_key) DO UPDATE"));
        assert!(POSTGRES_TOKEN_BUCKET_UPSERT_SQL.contains("WHERE LEAST"));
        assert!(POSTGRES_TOKEN_BUCKET_CLEANUP_SQL.contains("expires_at <= $1"));
    }

    #[test]
    fn request_id_reuses_safe_header_or_issues_one() {
        let metrics = MeshMetrics::default();
        let mut headers = HeaderMap::new();
        headers.insert("x-request-id", HeaderValue::from_static("req-fixed_1"));
        assert_eq!(request_id_from_headers(&headers, &metrics), "req-fixed_1");
        assert_eq!(metrics.snapshot().request_ids_issued, 0);
        headers.insert("x-request-id", HeaderValue::from_static("bad space"));
        assert!(request_id_from_headers(&headers, &metrics).starts_with("req_"));
        assert_eq!(metrics.snapshot().request_ids_issued, 1);
    }
}
