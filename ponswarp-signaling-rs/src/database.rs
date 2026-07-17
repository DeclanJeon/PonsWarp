//! Optional Postgres persistence for Cloud Drop monetization state.

use crate::config::Config;
use crate::handlers::cloud_share::{CloudFileManifest, CloudShareManifest};
use anyhow::{bail, Context, Result};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

pub struct CloudDatabase {
    pool: PgPool,
}

#[derive(Debug, Clone)]
pub struct AdminMemberRecord {
    pub role: String,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct AdminOverviewRecord {
    pub total_users: i64,
    pub active_subscriptions: i64,
    pub active_drop_passes: i64,
    pub active_cloud_shares: i64,
    pub stored_cloud_bytes: i64,
    pub billing_events: i64,
}

#[derive(Debug, Clone)]
pub struct AdminOperationsRecord {
    pub users: Vec<AdminUserListRecord>,
    pub subscriptions: Vec<AdminSubscriptionListRecord>,
    pub drop_passes: Vec<AdminDropPassListRecord>,
    pub cloud_shares: Vec<AdminCloudShareListRecord>,
    pub billing_events: Vec<AdminBillingEventListRecord>,
}

#[derive(Debug, Clone)]
pub struct AdminUserListRecord {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub plan: String,
    pub created_at: u64,
    pub last_login_at: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct AdminSubscriptionListRecord {
    pub id: String,
    pub email: String,
    pub status: String,
    pub provider_subscription_id: Option<String>,
    pub current_period_end: Option<u64>,
    pub updated_at: u64,
}

#[derive(Debug, Clone)]
pub struct AdminDropPassListRecord {
    pub id: String,
    pub email: Option<String>,
    pub sku: String,
    pub status: String,
    pub remaining_uses: i32,
    pub max_total_bytes: u64,
    pub retention_seconds: u64,
    pub created_at: u64,
    pub expires_at: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct AdminCloudShareListRecord {
    pub id: String,
    pub owner_email: Option<String>,
    pub root_name: String,
    pub total_size: u64,
    pub total_files: i32,
    pub completed: bool,
    pub download_count: i32,
    pub download_limit: Option<i32>,
    pub created_at: u64,
    pub expires_at: u64,
    pub deleted_at: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct AdminBillingEventListRecord {
    pub provider: String,
    pub id: String,
    pub event_type: String,
    pub created_at: u64,
    pub processed_at: u64,
}

pub struct CloudSharePolicyRecord {
    pub plan_snapshot: Value,
    pub owner_user_id: Option<Uuid>,
    pub drop_pass_id: Option<Uuid>,
    pub password_hash: Option<String>,
    pub download_limit: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct EntitlementRecord {
    pub owner_user_id: Option<Uuid>,
    pub drop_pass_id: Option<Uuid>,
    pub sku: String,
    pub label: String,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub retention_seconds: u64,
    pub download_limit: Option<u32>,
    pub monthly_quota_bytes: Option<u64>,
    pub concurrent_storage_bytes: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct CloudUsageRecord {
    pub monthly_completed_bytes: u64,
    pub active_reserved_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct CloudShareAccessRecord {
    pub password_hash: Option<String>,
    pub download_limit: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct AuthUserRecord {
    pub id: Uuid,
    pub email: String,
    pub name: Option<String>,
    pub picture_url: Option<String>,
}

pub struct GoogleUserInput<'a> {
    pub google_sub: &'a str,
    pub email: &'a str,
    pub name: Option<&'a str>,
    pub picture_url: Option<&'a str>,
    pub now: u64,
}

pub struct PayPalOrderEntitlementInput<'a> {
    pub paypal_order_id: &'a str,
    pub paypal_capture_id: &'a str,
    pub user_id: Option<Uuid>,
    pub email: Option<&'a str>,
    pub sku: &'a str,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub retention_seconds: u64,
    pub created_at: u64,
}

pub struct PayPalSubscriptionEntitlementInput<'a> {
    pub paypal_subscription_id: &'a str,
    pub paypal_plan_id: Option<&'a str>,
    pub user_id: Option<Uuid>,
    pub email: Option<&'a str>,
    pub created_at: u64,
}

pub struct LemonSqueezyOrderEntitlementInput<'a> {
    pub lemonsqueezy_order_id: &'a str,
    pub lemonsqueezy_checkout_ref: &'a str,
    pub user_id: Option<Uuid>,
    pub email: Option<&'a str>,
    pub sku: &'a str,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub retention_seconds: u64,
    pub created_at: u64,
}

pub struct LemonSqueezySubscriptionEntitlementInput<'a> {
    pub lemonsqueezy_subscription_id: &'a str,
    pub lemonsqueezy_checkout_ref: Option<&'a str>,
    pub lemonsqueezy_variant_id: Option<&'a str>,
    pub lemonsqueezy_customer_id: Option<&'a str>,
    pub payment_update_url: Option<&'a str>,
    pub status: &'a str,
    pub user_id: Option<Uuid>,
    pub email: Option<&'a str>,
    pub current_period_start: Option<u64>,
    pub current_period_end: Option<u64>,
    pub created_at: u64,
}

impl CloudDatabase {
    pub async fn from_config(config: &Config) -> Result<Option<Self>> {
        let database = &config.database;
        if database.url.trim().is_empty() {
            if config.cloud.billing_enabled {
                bail!("PONSWARP_BILLING_ENABLED=true requires DATABASE_URL or POSTGRES_URL");
            }
            tracing::info!("Cloud Drop database disabled: DATABASE_URL is not configured");
            return Ok(None);
        }

        let pool = PgPoolOptions::new()
            .max_connections(database.max_connections)
            .connect(&database.url)
            .await
            .context("failed to connect to Postgres")?;

        if database.run_migrations {
            sqlx::migrate!("./migrations")
                .run(&pool)
                .await
                .context("failed to run Cloud Drop migrations")?;
        }

        tracing::info!("Cloud Drop database enabled");
        Ok(Some(Self { pool }))
    }

    pub async fn insert_oauth_state(
        &self,
        state: &str,
        return_path: &str,
        created_at: u64,
        expires_at: u64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO oauth_states (state, return_path, created_at, expires_at)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(state)
        .bind(return_path)
        .bind(to_i64(created_at))
        .bind(to_i64(expires_at))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn consume_oauth_state(
        &self,
        state: &str,
        now: u64,
    ) -> Result<Option<String>, sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            r#"
            UPDATE oauth_states
            SET consumed_at = $2
            WHERE state = $1
              AND consumed_at IS NULL
              AND expires_at > $2
            RETURNING return_path
            "#,
        )
        .bind(state)
        .bind(to_i64(now))
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(row.map(|row| row.get("return_path")))
    }

    pub async fn upsert_google_user(
        &self,
        input: GoogleUserInput<'_>,
    ) -> Result<AuthUserRecord, sqlx::Error> {
        let row = sqlx::query(
            r#"
            INSERT INTO users (
                id, email, google_sub, name, picture_url, created_at,
                updated_at, last_login_at, plan
            )
            VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'free')
            ON CONFLICT (email) DO UPDATE SET
                google_sub = EXCLUDED.google_sub,
                name = EXCLUDED.name,
                picture_url = EXCLUDED.picture_url,
                updated_at = EXCLUDED.updated_at,
                last_login_at = EXCLUDED.last_login_at
            RETURNING id, email, name, picture_url
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(normalize_email(input.email).unwrap_or(input.email))
        .bind(input.google_sub)
        .bind(input.name)
        .bind(input.picture_url)
        .bind(to_i64(input.now))
        .fetch_one(&self.pool)
        .await?;

        Ok(auth_user_from_row(&row))
    }

    pub async fn insert_auth_session(
        &self,
        user_id: Uuid,
        token_hash: &str,
        created_at: u64,
        expires_at: u64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO auth_sessions (
                id, user_id, token_hash, created_at, expires_at, last_seen_at
            )
            VALUES ($1, $2, $3, $4, $5, $4)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(token_hash)
        .bind(to_i64(created_at))
        .bind(to_i64(expires_at))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn user_for_session(
        &self,
        token_hash: &str,
        now: u64,
    ) -> Result<Option<AuthUserRecord>, sqlx::Error> {
        let Some(row) = sqlx::query(
            r#"
            UPDATE auth_sessions s
            SET last_seen_at = $2
            FROM users u
            WHERE s.token_hash = $1
              AND s.user_id = u.id
              AND s.revoked_at IS NULL
              AND s.expires_at > $2
            RETURNING u.id, u.email, u.name, u.picture_url
            "#,
        )
        .bind(token_hash)
        .bind(to_i64(now))
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        Ok(Some(auth_user_from_row(&row)))
    }

    pub async fn revoke_auth_session(&self, token_hash: &str, now: u64) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE auth_sessions
            SET revoked_at = $2
            WHERE token_hash = $1 AND revoked_at IS NULL
            "#,
        )
        .bind(token_hash)
        .bind(to_i64(now))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn admin_for_user(
        &self,
        user_id: Uuid,
    ) -> Result<Option<AdminMemberRecord>, sqlx::Error> {
        let row = sqlx::query(
            r#"
            SELECT role, status
            FROM admin_members
            WHERE user_id = $1 AND status = 'active'
            "#,
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|row| AdminMemberRecord {
            role: row.get("role"),
            status: row.get("status"),
        }))
    }

    pub async fn ensure_bootstrap_admin(&self, user_id: Uuid, now: u64) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO admin_members (id, user_id, role, status, created_by, created_at, updated_at)
            VALUES ($1, $2, 'owner', 'active', $2, $3, $3)
            ON CONFLICT (user_id) DO UPDATE SET
                role = CASE
                    WHEN admin_members.role = 'owner' THEN admin_members.role
                    ELSE EXCLUDED.role
                END,
                status = 'active',
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(to_i64(now))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn admin_overview(&self, now: u64) -> Result<AdminOverviewRecord, sqlx::Error> {
        let row = sqlx::query(
            r#"
            SELECT
                (SELECT COUNT(*) FROM users) AS total_users,
                (SELECT COUNT(*) FROM subscriptions WHERE status IN ('active', 'trialing')) AS active_subscriptions,
                (SELECT COUNT(*) FROM drop_passes WHERE status = 'active' AND remaining_uses > 0 AND (expires_at IS NULL OR expires_at > $1)) AS active_drop_passes,
                (SELECT COUNT(*) FROM cloud_shares WHERE completed = true AND deleted_at IS NULL AND expires_at > $1) AS active_cloud_shares,
                (SELECT COALESCE(SUM(total_size), 0)::bigint FROM cloud_shares WHERE completed = true AND deleted_at IS NULL AND expires_at > $1) AS stored_cloud_bytes,
                (
                    (SELECT COUNT(*) FROM paypal_events) +
                    (SELECT COUNT(*) FROM lemonsqueezy_events)
                ) AS billing_events
            "#,
        )
        .bind(to_i64(now))
        .fetch_one(&self.pool)
        .await?;

        Ok(AdminOverviewRecord {
            total_users: row.get("total_users"),
            active_subscriptions: row.get("active_subscriptions"),
            active_drop_passes: row.get("active_drop_passes"),
            active_cloud_shares: row.get("active_cloud_shares"),
            stored_cloud_bytes: row.get("stored_cloud_bytes"),
            billing_events: row.get("billing_events"),
        })
    }

    pub async fn admin_operations(&self) -> Result<AdminOperationsRecord, sqlx::Error> {
        let users = sqlx::query(
            r#"
            SELECT id::text, email, name, plan, created_at, last_login_at
            FROM users
            ORDER BY COALESCE(last_login_at, updated_at, created_at) DESC
            LIMIT 25
            "#,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| AdminUserListRecord {
            id: row.get("id"),
            email: row.get("email"),
            name: row.get("name"),
            plan: row.get("plan"),
            created_at: from_i64(row.get("created_at")),
            last_login_at: row.get::<Option<i64>, _>("last_login_at").map(from_i64),
        })
        .collect();

        let subscriptions = sqlx::query(
            r#"
            SELECT
                s.id::text,
                u.email,
                s.status,
                COALESCE(
                    s.lemonsqueezy_subscription_id,
                    s.paypal_subscription_id,
                    s.stripe_subscription_id
                ) AS provider_subscription_id,
                s.current_period_end,
                s.updated_at
            FROM subscriptions s
            JOIN users u ON u.id = s.user_id
            ORDER BY s.updated_at DESC
            LIMIT 25
            "#,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| AdminSubscriptionListRecord {
            id: row.get("id"),
            email: row.get("email"),
            status: row.get("status"),
            provider_subscription_id: row.get("provider_subscription_id"),
            current_period_end: row
                .get::<Option<i64>, _>("current_period_end")
                .map(from_i64),
            updated_at: from_i64(row.get("updated_at")),
        })
        .collect();

        let drop_passes = sqlx::query(
            r#"
            SELECT
                dp.id::text,
                COALESCE(u.email, dp.email) AS email,
                dp.sku,
                dp.status,
                dp.remaining_uses,
                dp.max_total_bytes,
                dp.retention_seconds,
                dp.created_at,
                dp.expires_at
            FROM drop_passes dp
            LEFT JOIN users u ON u.id = dp.user_id
            ORDER BY dp.created_at DESC
            LIMIT 25
            "#,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| AdminDropPassListRecord {
            id: row.get("id"),
            email: row.get("email"),
            sku: row.get("sku"),
            status: row.get("status"),
            remaining_uses: row.get("remaining_uses"),
            max_total_bytes: from_i64(row.get("max_total_bytes")),
            retention_seconds: from_i64(row.get("retention_seconds")),
            created_at: from_i64(row.get("created_at")),
            expires_at: row.get::<Option<i64>, _>("expires_at").map(from_i64),
        })
        .collect();

        let cloud_shares = sqlx::query(
            r#"
            SELECT
                cs.id,
                u.email AS owner_email,
                cs.root_name,
                cs.total_size,
                cs.total_files,
                cs.completed,
                cs.download_count,
                cs.download_limit,
                cs.created_at,
                cs.expires_at,
                cs.deleted_at
            FROM cloud_shares cs
            LEFT JOIN users u ON u.id = cs.owner_user_id
            ORDER BY cs.created_at DESC
            LIMIT 25
            "#,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| AdminCloudShareListRecord {
            id: row.get("id"),
            owner_email: row.get("owner_email"),
            root_name: row.get("root_name"),
            total_size: from_i64(row.get("total_size")),
            total_files: row.get("total_files"),
            completed: row.get("completed"),
            download_count: row.get("download_count"),
            download_limit: row.get("download_limit"),
            created_at: from_i64(row.get("created_at")),
            expires_at: from_i64(row.get("expires_at")),
            deleted_at: row.get::<Option<i64>, _>("deleted_at").map(from_i64),
        })
        .collect();

        let billing_events = sqlx::query(
            r#"
            SELECT provider, id, event_type, created_at, processed_at
            FROM (
                SELECT 'paypal' AS provider, id, event_type, created_at, processed_at
                FROM paypal_events
                UNION ALL
                SELECT 'lemonsqueezy' AS provider, id, event_type, created_at, processed_at
                FROM lemonsqueezy_events
            ) events
            ORDER BY processed_at DESC
            LIMIT 40
            "#,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| AdminBillingEventListRecord {
            provider: row.get("provider"),
            id: row.get("id"),
            event_type: row.get("event_type"),
            created_at: from_i64(row.get("created_at")),
            processed_at: from_i64(row.get("processed_at")),
        })
        .collect();

        Ok(AdminOperationsRecord {
            users,
            subscriptions,
            drop_passes,
            cloud_shares,
            billing_events,
        })
    }

    pub async fn insert_cloud_share(
        &self,
        manifest: &CloudShareManifest,
        policy: CloudSharePolicyRecord,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;

        sqlx::query(
            r#"
            INSERT INTO cloud_shares (
                id, owner_user_id, drop_pass_id, plan_snapshot, root_name,
                total_size, total_files, completed, password_hash,
                download_limit, created_at, expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (id) DO UPDATE SET
                owner_user_id = EXCLUDED.owner_user_id,
                drop_pass_id = EXCLUDED.drop_pass_id,
                plan_snapshot = EXCLUDED.plan_snapshot,
                root_name = EXCLUDED.root_name,
                total_size = EXCLUDED.total_size,
                total_files = EXCLUDED.total_files,
                completed = EXCLUDED.completed,
                password_hash = EXCLUDED.password_hash,
                download_limit = EXCLUDED.download_limit,
                created_at = EXCLUDED.created_at,
                expires_at = EXCLUDED.expires_at,
                deleted_at = NULL
            "#,
        )
        .bind(&manifest.share_id)
        .bind(policy.owner_user_id)
        .bind(policy.drop_pass_id)
        .bind(policy.plan_snapshot)
        .bind(&manifest.root_name)
        .bind(to_i64(manifest.total_size))
        .bind(to_i32(manifest.total_files))
        .bind(manifest.completed)
        .bind(policy.password_hash)
        .bind(policy.download_limit.map(to_i32_from_u32))
        .bind(to_i64(manifest.created_at))
        .bind(to_i64(manifest.expires_at))
        .execute(&mut *tx)
        .await?;

        for file in &manifest.files {
            sqlx::query(
                r#"
                INSERT INTO cloud_share_files (
                    id, share_id, name, path, size, content_type,
                    last_modified, object_key
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (id) DO UPDATE SET
                    share_id = EXCLUDED.share_id,
                    name = EXCLUDED.name,
                    path = EXCLUDED.path,
                    size = EXCLUDED.size,
                    content_type = EXCLUDED.content_type,
                    last_modified = EXCLUDED.last_modified,
                    object_key = EXCLUDED.object_key
                "#,
            )
            .bind(&file.id)
            .bind(&manifest.share_id)
            .bind(&file.name)
            .bind(&file.path)
            .bind(to_i64(file.size))
            .bind(&file.content_type)
            .bind(file.last_modified.map(to_i64))
            .bind(&file.object_key)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn cloud_share_access(
        &self,
        share_id: &str,
    ) -> Result<Option<CloudShareAccessRecord>, sqlx::Error> {
        let Some(row) = sqlx::query(
            r#"
            SELECT password_hash, download_limit
            FROM cloud_shares
            WHERE id = $1 AND deleted_at IS NULL
            "#,
        )
        .bind(share_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        Ok(Some(CloudShareAccessRecord {
            password_hash: row.get("password_hash"),
            download_limit: row
                .get::<Option<i32>, _>("download_limit")
                .and_then(|value| u32::try_from(value).ok()),
        }))
    }

    pub async fn insert_cloud_download_session(
        &self,
        share_id: &str,
        token_hash: &str,
        created_at: u64,
        expires_at: u64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO cloud_download_sessions (
                id, share_id, token_hash, created_at, expires_at
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (token_hash) DO NOTHING
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(share_id)
        .bind(token_hash)
        .bind(to_i64(created_at))
        .bind(to_i64(expires_at))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn cloud_download_session_exists(
        &self,
        share_id: &str,
        token_hash: &str,
        now: u64,
    ) -> Result<bool, sqlx::Error> {
        let row = sqlx::query(
            r#"
            SELECT 1
            FROM cloud_download_sessions
            WHERE share_id = $1
              AND token_hash = $2
              AND expires_at > $3
            "#,
        )
        .bind(share_id)
        .bind(token_hash)
        .bind(to_i64(now))
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.is_some())
    }

    pub async fn try_record_paypal_event(
        &self,
        event_id: &str,
        event_type: &str,
        created_at: u64,
        processed_at: u64,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            INSERT INTO paypal_events (id, event_type, created_at, processed_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(event_id)
        .bind(event_type)
        .bind(to_i64(created_at))
        .bind(to_i64(processed_at))
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }

    pub async fn try_record_lemonsqueezy_event(
        &self,
        event_id: &str,
        event_type: &str,
        created_at: u64,
        processed_at: u64,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            INSERT INTO lemonsqueezy_events (id, event_type, created_at, processed_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(event_id)
        .bind(event_type)
        .bind(to_i64(created_at))
        .bind(to_i64(processed_at))
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }

    pub async fn upsert_paypal_order_entitlement(
        &self,
        input: PayPalOrderEntitlementInput<'_>,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let user_id = match input.user_id {
            Some(user_id) => Some(user_id),
            None => user_id_for_email(&mut tx, input.email, input.created_at).await?,
        };

        sqlx::query(
            r#"
            INSERT INTO drop_passes (
                id, user_id, email, paypal_order_id, paypal_capture_id,
                sku, status, max_total_bytes, max_file_bytes,
                retention_seconds, remaining_uses, created_at, expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, 1, $10, $11)
            ON CONFLICT (paypal_order_id) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                email = EXCLUDED.email,
                paypal_capture_id = EXCLUDED.paypal_capture_id,
                sku = EXCLUDED.sku,
                status = CASE WHEN drop_passes.status = 'consumed' THEN drop_passes.status ELSE 'active' END,
                max_total_bytes = EXCLUDED.max_total_bytes,
                max_file_bytes = EXCLUDED.max_file_bytes,
                retention_seconds = EXCLUDED.retention_seconds,
                expires_at = EXCLUDED.expires_at
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(input.email.and_then(normalize_email))
        .bind(input.paypal_order_id)
        .bind(input.paypal_capture_id)
        .bind(input.sku)
        .bind(to_i64(input.max_total_bytes))
        .bind(to_i64(input.max_file_bytes))
        .bind(to_i64(input.retention_seconds))
        .bind(to_i64(input.created_at))
        .bind(to_i64(input.created_at.saturating_add(30 * 24 * 60 * 60)))
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    pub async fn upsert_paypal_subscription_entitlement(
        &self,
        input: PayPalSubscriptionEntitlementInput<'_>,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let fallback_email;
        let user_id = match input.user_id {
            Some(user_id) => user_id,
            None => {
                let email = match input.email.and_then(normalize_email) {
                    Some(email) => email,
                    None => {
                        fallback_email = paypal_local_email(input.paypal_subscription_id);
                        &fallback_email
                    }
                };
                user_id_for_email(&mut tx, Some(email), input.created_at)
                    .await?
                    .expect("subscription email fallback always creates a user")
            }
        };

        sqlx::query(
            r#"
            INSERT INTO subscriptions (
                id, user_id, paypal_subscription_id, paypal_plan_id,
                status, current_period_start, current_period_end, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, 'active', NULL, NULL, $5, $5)
            ON CONFLICT (paypal_subscription_id) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                paypal_plan_id = EXCLUDED.paypal_plan_id,
                status = 'active',
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(input.paypal_subscription_id)
        .bind(input.paypal_plan_id)
        .bind(to_i64(input.created_at))
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    pub async fn upsert_lemonsqueezy_order_entitlement(
        &self,
        input: LemonSqueezyOrderEntitlementInput<'_>,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let user_id = match input.user_id {
            Some(user_id) => Some(user_id),
            None => user_id_for_email(&mut tx, input.email, input.created_at).await?,
        };

        sqlx::query(
            r#"
            INSERT INTO drop_passes (
                id, user_id, email, lemonsqueezy_order_id, lemonsqueezy_checkout_ref,
                sku, status, max_total_bytes, max_file_bytes,
                retention_seconds, remaining_uses, created_at, expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, 1, $10, $11)
            ON CONFLICT (lemonsqueezy_checkout_ref) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                email = EXCLUDED.email,
                lemonsqueezy_order_id = EXCLUDED.lemonsqueezy_order_id,
                sku = EXCLUDED.sku,
                status = CASE WHEN drop_passes.status = 'consumed' THEN drop_passes.status ELSE 'active' END,
                max_total_bytes = EXCLUDED.max_total_bytes,
                max_file_bytes = EXCLUDED.max_file_bytes,
                retention_seconds = EXCLUDED.retention_seconds,
                expires_at = EXCLUDED.expires_at
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(input.email.and_then(normalize_email))
        .bind(input.lemonsqueezy_order_id)
        .bind(input.lemonsqueezy_checkout_ref)
        .bind(input.sku)
        .bind(to_i64(input.max_total_bytes))
        .bind(to_i64(input.max_file_bytes))
        .bind(to_i64(input.retention_seconds))
        .bind(to_i64(input.created_at))
        .bind(to_i64(input.created_at.saturating_add(30 * 24 * 60 * 60)))
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    pub async fn upsert_lemonsqueezy_subscription_entitlement(
        &self,
        input: LemonSqueezySubscriptionEntitlementInput<'_>,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let fallback_email;
        let user_id = match input.user_id {
            Some(user_id) => user_id,
            None => {
                let email = match input.email.and_then(normalize_email) {
                    Some(email) => email,
                    None => {
                        fallback_email =
                            lemonsqueezy_local_email(input.lemonsqueezy_subscription_id);
                        &fallback_email
                    }
                };
                user_id_for_email(&mut tx, Some(email), input.created_at)
                    .await?
                    .expect("subscription email fallback always creates a user")
            }
        };

        sqlx::query(
            r#"
            INSERT INTO subscriptions (
                id, user_id, lemonsqueezy_subscription_id, lemonsqueezy_checkout_ref,
                lemonsqueezy_variant_id, lemonsqueezy_customer_id, payment_update_url,
                status, current_period_start, current_period_end, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
            ON CONFLICT (lemonsqueezy_subscription_id) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                lemonsqueezy_checkout_ref = COALESCE(EXCLUDED.lemonsqueezy_checkout_ref, subscriptions.lemonsqueezy_checkout_ref),
                lemonsqueezy_variant_id = EXCLUDED.lemonsqueezy_variant_id,
                lemonsqueezy_customer_id = EXCLUDED.lemonsqueezy_customer_id,
                payment_update_url = EXCLUDED.payment_update_url,
                status = EXCLUDED.status,
                current_period_start = EXCLUDED.current_period_start,
                current_period_end = EXCLUDED.current_period_end,
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(input.lemonsqueezy_subscription_id)
        .bind(input.lemonsqueezy_checkout_ref)
        .bind(input.lemonsqueezy_variant_id)
        .bind(input.lemonsqueezy_customer_id)
        .bind(input.payment_update_url)
        .bind(input.status)
        .bind(input.current_period_start.map(to_i64))
        .bind(input.current_period_end.map(to_i64))
        .bind(to_i64(input.created_at))
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    pub async fn set_paypal_subscription_status(
        &self,
        paypal_subscription_id: &str,
        status: &str,
        updated_at: u64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE subscriptions
            SET status = $2, updated_at = $3
            WHERE paypal_subscription_id = $1
            "#,
        )
        .bind(paypal_subscription_id)
        .bind(status)
        .bind(to_i64(updated_at))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn resolve_entitlement(
        &self,
        token: &str,
        now: u64,
    ) -> Result<Option<EntitlementRecord>, sqlx::Error> {
        if let Some(row) = sqlx::query(
            r#"
            SELECT id, user_id, sku, max_total_bytes, max_file_bytes,
                   retention_seconds, expires_at
            FROM drop_passes
            WHERE (
                    paypal_order_id = $1
                 OR stripe_checkout_session_id = $1
                 OR lemonsqueezy_order_id = $1
                 OR lemonsqueezy_checkout_ref = $1
            )
              AND status = 'active'
              AND remaining_uses > 0
              AND (expires_at IS NULL OR expires_at > $2)
            "#,
        )
        .bind(token)
        .bind(to_i64(now))
        .fetch_optional(&self.pool)
        .await?
        {
            let sku: String = row.get("sku");
            return Ok(Some(EntitlementRecord {
                owner_user_id: row.get("user_id"),
                drop_pass_id: Some(row.get("id")),
                label: paid_label(&sku),
                download_limit: drop_pass_download_limit(&sku),
                sku,
                max_total_bytes: from_i64(row.get("max_total_bytes")),
                max_file_bytes: from_i64(row.get("max_file_bytes")),
                retention_seconds: from_i64(row.get("retention_seconds")),
                monthly_quota_bytes: None,
                concurrent_storage_bytes: None,
            }));
        }

        if let Some(row) = sqlx::query(
            r#"
            SELECT s.user_id, s.paypal_subscription_id, s.lemonsqueezy_subscription_id
            FROM subscriptions s
            WHERE (
                    s.paypal_subscription_id = $1
                 OR s.stripe_checkout_session_id = $1
                 OR s.lemonsqueezy_subscription_id = $1
                 OR s.lemonsqueezy_checkout_ref = $1
            )
              AND s.status IN ('active', 'trialing')
            "#,
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await?
        {
            const TB: u64 = 1024 * 1024 * 1024 * 1024;
            return Ok(Some(EntitlementRecord {
                owner_user_id: Some(row.get("user_id")),
                drop_pass_id: None,
                sku: "pro_monthly_krw_9900".to_string(),
                label: "PonsWarp Pro".to_string(),
                max_total_bytes: TB,
                max_file_bytes: TB,
                retention_seconds: 7 * 24 * 60 * 60,
                download_limit: Some(30),
                monthly_quota_bytes: Some(2 * TB),
                concurrent_storage_bytes: Some(TB),
            }));
        }

        Ok(None)
    }

    pub async fn cloud_usage_for_user(
        &self,
        user_id: Uuid,
        monthly_period_start: u64,
        now: u64,
    ) -> Result<CloudUsageRecord, sqlx::Error> {
        let row = sqlx::query(
            r#"
            SELECT
                (
                    SELECT COALESCE(SUM(bytes), 0)::bigint
                    FROM cloud_usage_events
                    WHERE user_id = $1
                      AND event_type = 'cloud_share_completed'
                      AND created_at >= $2
                ) AS monthly_completed_bytes,
                (
                    SELECT COALESCE(SUM(total_size), 0)::bigint
                    FROM cloud_shares
                    WHERE owner_user_id = $1
                      AND deleted_at IS NULL
                      AND expires_at > $3
                ) AS active_reserved_bytes
            "#,
        )
        .bind(user_id)
        .bind(to_i64(monthly_period_start))
        .bind(to_i64(now))
        .fetch_one(&self.pool)
        .await?;

        Ok(CloudUsageRecord {
            monthly_completed_bytes: from_i64(row.get("monthly_completed_bytes")),
            active_reserved_bytes: from_i64(row.get("active_reserved_bytes")),
        })
    }

    pub async fn consume_drop_pass(&self, drop_pass_id: Uuid) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"
            UPDATE drop_passes
            SET status = 'consumed', remaining_uses = 0
            WHERE id = $1 AND status = 'active' AND remaining_uses > 0
            "#,
        )
        .bind(drop_pass_id)
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }

    pub async fn consume_download_session(
        &self,
        share_id: &str,
        token_hash: &str,
        now: u64,
    ) -> Result<bool, sqlx::Error> {
        let mut tx = self.pool.begin().await?;

        let fresh_session = sqlx::query(
            r#"
            UPDATE cloud_download_sessions
            SET counted_at = $3
            WHERE share_id = $1
              AND token_hash = $2
              AND expires_at > $3
              AND counted_at IS NULL
            "#,
        )
        .bind(share_id)
        .bind(token_hash)
        .bind(to_i64(now))
        .execute(&mut *tx)
        .await?;

        if fresh_session.rows_affected() == 0 {
            let existing = sqlx::query(
                r#"
                SELECT 1
                FROM cloud_download_sessions
                WHERE share_id = $1
                  AND token_hash = $2
                  AND expires_at > $3
                  AND counted_at IS NOT NULL
                "#,
            )
            .bind(share_id)
            .bind(token_hash)
            .bind(to_i64(now))
            .fetch_optional(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(existing.is_some());
        }

        let share_updated = sqlx::query(
            r#"
            UPDATE cloud_shares
            SET download_count = download_count + 1
            WHERE id = $1
              AND deleted_at IS NULL
              AND (download_limit IS NULL OR download_count < download_limit)
            "#,
        )
        .bind(share_id)
        .execute(&mut *tx)
        .await?;

        if share_updated.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(false);
        }

        tx.commit().await?;
        Ok(true)
    }

    pub async fn mark_cloud_share_completed(
        &self,
        share_id: &str,
        total_size: u64,
        created_at: u64,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;

        let update = sqlx::query("UPDATE cloud_shares SET completed = true WHERE id = $1")
            .bind(share_id)
            .execute(&mut *tx)
            .await?;

        if update.rows_affected() > 0 {
            sqlx::query(
                r#"
                INSERT INTO cloud_usage_events (
                    id, user_id, share_id, event_type, bytes, created_at
                )
                SELECT $1, owner_user_id, id, 'cloud_share_completed', $3, $4
                FROM cloud_shares
                WHERE id = $2
                "#,
            )
            .bind(uuid::Uuid::new_v4())
            .bind(share_id)
            .bind(to_i64(total_size))
            .bind(to_i64(created_at))
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn mark_cloud_share_deleted(
        &self,
        share_id: &str,
        deleted_at: u64,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE cloud_shares SET deleted_at = $2 WHERE id = $1")
            .bind(share_id)
            .bind(to_i64(deleted_at))
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM cloud_download_sessions WHERE share_id = $1")
            .bind(share_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn set_lemonsqueezy_subscription_status(
        &self,
        lemonsqueezy_subscription_id: &str,
        status: &str,
        updated_at: u64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            UPDATE subscriptions
            SET status = $2, updated_at = $3
            WHERE lemonsqueezy_subscription_id = $1
            "#,
        )
        .bind(lemonsqueezy_subscription_id)
        .bind(status)
        .bind(to_i64(updated_at))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn read_cloud_share(
        &self,
        share_id: &str,
    ) -> Result<Option<CloudShareManifest>, sqlx::Error> {
        let Some(share) = sqlx::query(
            r#"
            SELECT id, root_name, total_size, total_files, created_at, expires_at, completed
            FROM cloud_shares
            WHERE id = $1 AND deleted_at IS NULL
            "#,
        )
        .bind(share_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        let file_rows = sqlx::query(
            r#"
            SELECT id, name, path, size, content_type, last_modified, object_key
            FROM cloud_share_files
            WHERE share_id = $1
            ORDER BY path, id
            "#,
        )
        .bind(share_id)
        .fetch_all(&self.pool)
        .await?;

        let files = file_rows
            .into_iter()
            .map(|row| CloudFileManifest {
                id: row.get("id"),
                name: row.get("name"),
                path: row.get("path"),
                size: from_i64(row.get("size")),
                content_type: row.get("content_type"),
                last_modified: row.get::<Option<i64>, _>("last_modified").map(from_i64),
                object_key: row.get("object_key"),
            })
            .collect::<Vec<_>>();

        Ok(Some(CloudShareManifest {
            share_id: share.get("id"),
            root_name: share.get("root_name"),
            total_size: from_i64(share.get("total_size")),
            total_files: share
                .get::<i32, _>("total_files")
                .try_into()
                .unwrap_or_default(),
            created_at: from_i64(share.get("created_at")),
            expires_at: from_i64(share.get("expires_at")),
            completed: share.get("completed"),
            files,
        }))
    }
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn to_i32(value: usize) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

fn to_i32_from_u32(value: u32) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

fn from_i64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or_default()
}

fn auth_user_from_row(row: &sqlx::postgres::PgRow) -> AuthUserRecord {
    AuthUserRecord {
        id: row.get("id"),
        email: row.get("email"),
        name: row.get("name"),
        picture_url: row.get("picture_url"),
    }
}

fn normalize_email(email: &str) -> Option<&str> {
    let email = email.trim();
    if email.is_empty() {
        None
    } else {
        Some(email)
    }
}

async fn user_id_for_email(
    tx: &mut Transaction<'_, Postgres>,
    email: Option<&str>,
    created_at: u64,
) -> Result<Option<Uuid>, sqlx::Error> {
    let Some(email) = email.and_then(normalize_email) else {
        return Ok(None);
    };
    let id = Uuid::new_v4();
    let row = sqlx::query(
        r#"
        INSERT INTO users (id, email, created_at, plan)
        VALUES ($1, $2, $3, 'free')
        ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
        RETURNING id
        "#,
    )
    .bind(id)
    .bind(email)
    .bind(to_i64(created_at))
    .fetch_one(&mut **tx)
    .await?;

    Ok(Some(row.get::<Uuid, _>("id")))
}

fn paypal_local_email(subscription_id: &str) -> String {
    let safe_id = subscription_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    format!("paypal+{}@ponswarp.local", safe_id)
}

fn lemonsqueezy_local_email(subscription_id: &str) -> String {
    let safe_id = subscription_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    format!("lemonsqueezy+{}@ponswarp.local", safe_id)
}

fn paid_label(sku: &str) -> String {
    match sku {
        "drop_100gb_3d" => "100GB Drop Pass",
        "drop_500gb_7d" => "500GB Drop Pass",
        "drop_1tb_7d" => "1TB Drop Pass",
        _ => "Cloud Drop Pass",
    }
    .to_string()
}

fn drop_pass_download_limit(sku: &str) -> Option<u32> {
    match sku {
        "drop_100gb_3d" => Some(10),
        "drop_500gb_7d" => Some(20),
        "drop_1tb_7d" => Some(30),
        _ => Some(30),
    }
}
