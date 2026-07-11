//! Hosted checkout and webhook handling for Cloud Drop entitlements.

use crate::auth::{current_session_user, UserIdentity};
use crate::config::Config;
use crate::database::{
    CloudDatabase, LemonSqueezyOrderEntitlementInput, LemonSqueezySubscriptionEntitlementInput,
    PayPalOrderEntitlementInput, PayPalSubscriptionEntitlementInput,
};
use crate::state::AppState;
use anyhow::{bail, Result};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

type HmacSha256 = Hmac<sha2::Sha256>;

#[derive(Clone)]
pub struct BillingClient {
    http: reqwest::Client,
    default_provider: CheckoutProvider,
    lemonsqueezy: Option<LemonSqueezySettings>,
    paypal: Option<PayPalSettings>,
    public_app_url: String,
}

#[derive(Clone)]
struct PayPalSettings {
    client_id: String,
    client_secret: String,
    webhook_id: String,
    api_base: String,
    currency: String,
    pro_plan_id: String,
}

#[derive(Clone)]
struct LemonSqueezySettings {
    api_key: String,
    api_base: String,
    store_id: String,
    webhook_secret: String,
    variant_drop_100gb_3d: String,
    variant_drop_500gb_7d: String,
    variant_drop_1tb_7d: String,
    variant_pro_monthly: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRequest {
    mode: CheckoutMode,
    sku: String,
    return_url: String,
    provider: Option<CheckoutProvider>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    order_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum CheckoutMode {
    Payment,
    Subscription,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CheckoutProvider {
    LemonSqueezy,
    PayPal,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutResponse {
    checkout_url: String,
    checkout_id: String,
    provider: CheckoutProvider,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResponse {
    entitlement_token: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PaymentProviderStatus {
    pub provider: CheckoutProvider,
    pub label: String,
    pub available: bool,
    pub default: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BillingErrorBody {
    error: String,
}

#[derive(Default)]
struct JsonPostOptions {
    prefer: Option<&'static str>,
    paypal_request_id: Option<String>,
}

impl JsonPostOptions {
    fn representation() -> Self {
        Self {
            prefer: Some("return=representation"),
            paypal_request_id: None,
        }
    }

    fn with_request_id(mut self, request_id: String) -> Self {
        self.paypal_request_id = Some(request_id);
        self
    }
}

impl PayPalSettings {
    fn from_config(config: &Config) -> Option<Self> {
        if config.billing.paypal_client_id.trim().is_empty()
            || config.billing.paypal_client_secret.trim().is_empty()
            || config.billing.paypal_webhook_id.trim().is_empty()
            || config.billing.paypal_pro_plan_id.trim().is_empty()
        {
            return None;
        }

        Some(Self {
            client_id: config.billing.paypal_client_id.clone(),
            client_secret: config.billing.paypal_client_secret.clone(),
            webhook_id: config.billing.paypal_webhook_id.clone(),
            api_base: config
                .billing
                .paypal_api_base
                .trim_end_matches('/')
                .to_string(),
            currency: config.billing.paypal_currency.to_uppercase(),
            pro_plan_id: config.billing.paypal_pro_plan_id.clone(),
        })
    }
}

impl LemonSqueezySettings {
    fn from_config(config: &Config) -> Option<Self> {
        if config.billing.lemonsqueezy_api_key.trim().is_empty()
            || config.billing.lemonsqueezy_store_id.trim().is_empty()
            || config.billing.lemonsqueezy_webhook_secret.trim().is_empty()
            || config
                .billing
                .lemonsqueezy_variant_drop_100gb_3d
                .trim()
                .is_empty()
            || config
                .billing
                .lemonsqueezy_variant_drop_500gb_7d
                .trim()
                .is_empty()
            || config
                .billing
                .lemonsqueezy_variant_drop_1tb_7d
                .trim()
                .is_empty()
            || config
                .billing
                .lemonsqueezy_variant_pro_monthly
                .trim()
                .is_empty()
        {
            return None;
        }

        Some(Self {
            api_key: config.billing.lemonsqueezy_api_key.clone(),
            api_base: config
                .billing
                .lemonsqueezy_api_base
                .trim_end_matches('/')
                .to_string(),
            store_id: config.billing.lemonsqueezy_store_id.clone(),
            webhook_secret: config.billing.lemonsqueezy_webhook_secret.clone(),
            variant_drop_100gb_3d: config.billing.lemonsqueezy_variant_drop_100gb_3d.clone(),
            variant_drop_500gb_7d: config.billing.lemonsqueezy_variant_drop_500gb_7d.clone(),
            variant_drop_1tb_7d: config.billing.lemonsqueezy_variant_drop_1tb_7d.clone(),
            variant_pro_monthly: config.billing.lemonsqueezy_variant_pro_monthly.clone(),
        })
    }

    fn variant_for_sku(&self, sku: &str) -> Option<&str> {
        match sku {
            "drop_100gb_3d" => non_empty(&self.variant_drop_100gb_3d),
            "drop_500gb_7d" => non_empty(&self.variant_drop_500gb_7d),
            "drop_1tb_7d" => non_empty(&self.variant_drop_1tb_7d),
            "pro_monthly_krw_9900" => non_empty(&self.variant_pro_monthly),
            _ => None,
        }
    }
}

impl BillingClient {
    pub fn from_config(config: &Config) -> Result<Option<Self>> {
        if !config.cloud.billing_enabled {
            return Ok(None);
        }

        if config.billing.public_app_url.trim().is_empty() {
            bail!("PONSWARP_BILLING_ENABLED=true requires PONSWARP_PUBLIC_APP_URL");
        }

        let configured_default_provider = parse_provider(&config.billing.default_provider)?;
        let lemonsqueezy = LemonSqueezySettings::from_config(config);
        let paypal = PayPalSettings::from_config(config);

        if lemonsqueezy.is_none() && paypal.is_none() {
            bail!(
                "PONSWARP_BILLING_ENABLED=true requires Lemon Squeezy or PayPal checkout credentials"
            );
        }
        let default_provider = match configured_default_provider {
            CheckoutProvider::LemonSqueezy if lemonsqueezy.is_none() => CheckoutProvider::PayPal,
            CheckoutProvider::PayPal if paypal.is_none() => CheckoutProvider::LemonSqueezy,
            provider => provider,
        };

        Ok(Some(Self {
            http: reqwest::Client::new(),
            default_provider,
            lemonsqueezy,
            paypal,
            public_app_url: config
                .billing
                .public_app_url
                .trim_end_matches('/')
                .to_string(),
        }))
    }

    pub fn payment_providers(&self) -> Vec<PaymentProviderStatus> {
        vec![
            PaymentProviderStatus {
                provider: CheckoutProvider::LemonSqueezy,
                label: "Lemon Squeezy".to_string(),
                available: self.lemonsqueezy.is_some(),
                default: self.default_provider == CheckoutProvider::LemonSqueezy,
            },
            PaymentProviderStatus {
                provider: CheckoutProvider::PayPal,
                label: "PayPal".to_string(),
                available: self.paypal.is_some(),
                default: self.default_provider == CheckoutProvider::PayPal,
            },
        ]
    }

    async fn create_checkout(
        &self,
        request: CheckoutRequest,
        user: &UserIdentity,
    ) -> Result<CheckoutResponse, BillingError> {
        let plan = paid_plan(&request.sku)
            .ok_or_else(|| BillingError::bad_request("Unknown Cloud Drop plan"))?;
        if request.mode != plan.checkout_mode {
            return Err(BillingError::bad_request(
                "Checkout mode does not match plan",
            ));
        }
        let return_url = self.validate_return_url(&request.return_url)?;
        let provider = request.provider.unwrap_or(self.default_provider);

        match provider {
            CheckoutProvider::LemonSqueezy => {
                self.create_lemonsqueezy_checkout(plan, &return_url, user)
                    .await
            }
            CheckoutProvider::PayPal => match request.mode {
                CheckoutMode::Payment => self.create_order_checkout(plan, &return_url, user).await,
                CheckoutMode::Subscription => {
                    self.create_subscription_checkout(plan, &return_url, user)
                        .await
                }
            },
        }
    }

    async fn create_lemonsqueezy_checkout(
        &self,
        plan: PaidPlan,
        return_url: &str,
        user: &UserIdentity,
    ) -> Result<CheckoutResponse, BillingError> {
        let Some(settings) = self.lemonsqueezy.as_ref() else {
            return Err(BillingError::unavailable(
                "Lemon Squeezy checkout is not configured",
            ));
        };
        let variant_id = settings.variant_for_sku(plan.sku).ok_or_else(|| {
            BillingError::unavailable("Lemon Squeezy variant is not configured for this plan")
        })?;
        let checkout_ref = Uuid::new_v4().simple().to_string();
        let checkout_return_url = append_query(
            &append_query(return_url, "checkout=success"),
            &format!(
                "provider=lemonsqueezy&checkout_id={}",
                url_query_value(&checkout_ref)
            ),
        );
        let payload = json!({
            "data": {
                "type": "checkouts",
                "attributes": {
                    "product_options": {
                        "name": plan.label,
                        "description": "PonsWarp Cloud Drop",
                        "redirect_url": checkout_return_url,
                        "receipt_button_text": "Return to PonsWarp",
                        "receipt_link_url": checkout_return_url
                    },
                    "checkout_options": {
                        "embed": false,
                        "media": false,
                        "logo": true,
                        "desc": true,
                        "discount": true,
                        "subscription_preview": true
                    },
                    "checkout_data": {
                        "email": user.email.as_str(),
                        "custom": {
                            "checkout_ref": checkout_ref.as_str(),
                            "sku": plan.sku,
                            "mode": plan.checkout_mode.as_str(),
                            "user_id": user.id.to_string()
                        }
                    }
                },
                "relationships": {
                    "store": {
                        "data": {
                            "type": "stores",
                            "id": settings.store_id.as_str()
                        }
                    },
                    "variant": {
                        "data": {
                            "type": "variants",
                            "id": variant_id
                        }
                    }
                }
            }
        });

        let value: Value = self
            .http
            .post(format!("{}/v1/checkouts", settings.api_base))
            .bearer_auth(&settings.api_key)
            .header("Accept", "application/vnd.api+json")
            .header("Content-Type", "application/vnd.api+json")
            .json(&payload)
            .send()
            .await
            .map_err(BillingError::internal)?
            .error_for_status()
            .map_err(BillingError::internal)?
            .json()
            .await
            .map_err(BillingError::internal)?;

        let checkout_url = value
            .pointer("/data/attributes/url")
            .and_then(Value::as_str)
            .ok_or_else(|| BillingError::internal("Lemon Squeezy did not return a checkout URL"))?
            .to_string();
        Ok(CheckoutResponse {
            checkout_url,
            checkout_id: checkout_ref,
            provider: CheckoutProvider::LemonSqueezy,
        })
    }

    async fn create_order_checkout(
        &self,
        plan: PaidPlan,
        return_url: &str,
        user: &UserIdentity,
    ) -> Result<CheckoutResponse, BillingError> {
        let Some(settings) = self.paypal.as_ref() else {
            return Err(BillingError::unavailable(
                "PayPal checkout is not configured",
            ));
        };
        let access_token = self.access_token(settings).await?;
        let payload = json!({
            "intent": "CAPTURE",
            "purchase_units": [{
                "reference_id": plan.sku,
                "custom_id": user.id.to_string(),
                "description": plan.label,
                "amount": {
                    "currency_code": settings.currency.as_str(),
                    "value": plan.paypal_amount(&settings.currency),
                },
            }],
            "payment_source": {
                "paypal": {
                    "experience_context": {
                        "brand_name": "PonsWarp",
                        "landing_page": "LOGIN",
                        "shipping_preference": "NO_SHIPPING",
                        "user_action": "PAY_NOW",
                        "return_url": append_query(return_url, "checkout=success"),
                        "cancel_url": append_query(return_url, "checkout=cancelled"),
                    },
                },
            },
        });

        let value = self
            .post_json_with_options(
                "/v2/checkout/orders",
                &access_token,
                &payload,
                JsonPostOptions::representation(),
            )
            .await?;
        let checkout_id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| BillingError::internal("PayPal did not return a checkout id"))?
            .to_string();
        approval_url(&value).map(|checkout_url| CheckoutResponse {
            checkout_url,
            checkout_id,
            provider: CheckoutProvider::PayPal,
        })
    }

    async fn create_subscription_checkout(
        &self,
        plan: PaidPlan,
        return_url: &str,
        user: &UserIdentity,
    ) -> Result<CheckoutResponse, BillingError> {
        let Some(settings) = self.paypal.as_ref() else {
            return Err(BillingError::unavailable(
                "PayPal checkout is not configured",
            ));
        };
        let access_token = self.access_token(settings).await?;
        let payload = json!({
            "plan_id": settings.pro_plan_id.as_str(),
            "custom_id": subscription_custom_id(plan.sku, user.id),
            "application_context": {
                "brand_name": "PonsWarp",
                "user_action": "SUBSCRIBE_NOW",
                "return_url": append_query(return_url, "checkout=success"),
                "cancel_url": append_query(return_url, "checkout=cancelled"),
            },
        });

        let value = self
            .post_json("/v1/billing/subscriptions", &access_token, &payload)
            .await?;
        let checkout_id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| BillingError::internal("PayPal did not return a checkout id"))?
            .to_string();
        approval_url(&value).map(|checkout_url| CheckoutResponse {
            checkout_url,
            checkout_id,
            provider: CheckoutProvider::PayPal,
        })
    }

    async fn capture_order(
        &self,
        database: &CloudDatabase,
        order_id: &str,
        user: &UserIdentity,
    ) -> Result<CaptureResponse, BillingError> {
        let order_id = order_id.trim();
        if order_id.is_empty() {
            return Err(BillingError::bad_request("Missing PayPal order id"));
        }

        if database
            .resolve_entitlement(order_id, unix_now())
            .await
            .map_err(BillingError::internal)?
            .is_some()
        {
            return Ok(CaptureResponse {
                entitlement_token: order_id.to_string(),
            });
        }

        let Some(settings) = self.paypal.as_ref() else {
            return Err(BillingError::unavailable(
                "PayPal checkout is not configured",
            ));
        };
        let access_token = self.access_token(settings).await?;
        let value = self
            .post_json_with_options(
                &format!("/v2/checkout/orders/{}/capture", url_path(order_id)),
                &access_token,
                &json!({}),
                JsonPostOptions::representation().with_request_id(capture_request_id(order_id)),
            )
            .await?;
        let status = value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if status != "COMPLETED" {
            return Err(BillingError::bad_request(
                "PayPal order has not completed payment",
            ));
        }

        let unit = value
            .pointer("/purchase_units/0")
            .ok_or_else(|| BillingError::bad_request("PayPal order is missing purchase unit"))?;
        let sku = unit
            .get("reference_id")
            .and_then(Value::as_str)
            .or_else(|| unit.get("custom_id").and_then(Value::as_str))
            .ok_or_else(|| BillingError::bad_request("PayPal order is missing Cloud Drop sku"))?;
        let Some(plan) = paid_plan(sku) else {
            return Err(BillingError::bad_request(
                "PayPal order has unknown Cloud Drop sku",
            ));
        };
        if plan.checkout_mode != CheckoutMode::Payment {
            return Err(BillingError::bad_request(
                "PayPal order cannot activate a subscription plan",
            ));
        }
        let capture_id = unit
            .pointer("/payments/captures/0/id")
            .and_then(Value::as_str)
            .ok_or_else(|| BillingError::bad_request("PayPal order is missing capture id"))?;
        database
            .upsert_paypal_order_entitlement(PayPalOrderEntitlementInput {
                paypal_order_id: order_id,
                paypal_capture_id: capture_id,
                user_id: Some(user.id),
                email: Some(user.email.as_str()),
                sku: plan.sku,
                max_total_bytes: plan.max_total_bytes,
                max_file_bytes: plan.max_file_bytes,
                retention_seconds: plan.retention_seconds,
                created_at: unix_now(),
            })
            .await
            .map_err(BillingError::internal)?;

        Ok(CaptureResponse {
            entitlement_token: order_id.to_string(),
        })
    }

    async fn validate_webhook(
        &self,
        headers: &HeaderMap,
        event: &Value,
    ) -> Result<(), BillingError> {
        let Some(settings) = self.paypal.as_ref() else {
            return Err(BillingError::unavailable(
                "PayPal webhook is not configured",
            ));
        };
        let access_token = self.access_token(settings).await?;
        let payload = json!({
            "auth_algo": required_header(headers, "paypal-auth-algo")?,
            "cert_url": required_header(headers, "paypal-cert-url")?,
            "transmission_id": required_header(headers, "paypal-transmission-id")?,
            "transmission_sig": required_header(headers, "paypal-transmission-sig")?,
            "transmission_time": required_header(headers, "paypal-transmission-time")?,
            "webhook_id": settings.webhook_id.as_str(),
            "webhook_event": event,
        });
        let value = self
            .post_json(
                "/v1/notifications/verify-webhook-signature",
                &access_token,
                &payload,
            )
            .await?;
        let status = value
            .get("verification_status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if status == "SUCCESS" {
            return Ok(());
        }

        Err(BillingError::bad_webhook(
            "PayPal webhook signature verification failed",
        ))
    }

    async fn access_token(&self, settings: &PayPalSettings) -> Result<String, BillingError> {
        let value: Value = self
            .http
            .post(format!("{}/v1/oauth2/token", settings.api_base))
            .basic_auth(&settings.client_id, Some(&settings.client_secret))
            .form(&[("grant_type", "client_credentials")])
            .send()
            .await
            .map_err(BillingError::internal)?
            .error_for_status()
            .map_err(BillingError::internal)?
            .json()
            .await
            .map_err(BillingError::internal)?;

        value
            .get("access_token")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| BillingError::internal("PayPal did not return an access token"))
    }

    async fn post_json(
        &self,
        path: &str,
        access_token: &str,
        payload: &Value,
    ) -> Result<Value, BillingError> {
        self.post_json_with_options(path, access_token, payload, JsonPostOptions::default())
            .await
    }

    async fn post_json_with_options(
        &self,
        path: &str,
        access_token: &str,
        payload: &Value,
        options: JsonPostOptions,
    ) -> Result<Value, BillingError> {
        let Some(settings) = self.paypal.as_ref() else {
            return Err(BillingError::unavailable(
                "PayPal checkout is not configured",
            ));
        };
        let mut request = self
            .http
            .post(format!("{}{}", settings.api_base, path))
            .bearer_auth(access_token)
            .json(payload);
        if let Some(prefer) = options.prefer {
            request = request.header("Prefer", prefer);
        }
        if let Some(request_id) = options.paypal_request_id {
            request = request.header("PayPal-Request-Id", request_id);
        }

        request
            .send()
            .await
            .map_err(BillingError::internal)?
            .error_for_status()
            .map_err(BillingError::internal)?
            .json()
            .await
            .map_err(BillingError::internal)
    }

    fn validate_return_url(&self, return_url: &str) -> Result<String, BillingError> {
        let trimmed = return_url.trim();
        if !trimmed.starts_with(&self.public_app_url) {
            return Err(BillingError::bad_request(
                "Checkout returnUrl is not allowed for this deployment",
            ));
        }
        Ok(trimmed.to_string())
    }

    fn validate_lemonsqueezy_webhook(
        &self,
        headers: &HeaderMap,
        body: &[u8],
    ) -> Result<(), BillingError> {
        let Some(settings) = self.lemonsqueezy.as_ref() else {
            return Err(BillingError::unavailable(
                "Lemon Squeezy webhook is not configured",
            ));
        };
        let signature = required_header(headers, "x-signature")?;
        let mut mac = HmacSha256::new_from_slice(settings.webhook_secret.as_bytes())
            .map_err(BillingError::internal)?;
        mac.update(body);
        let provided = hex_to_bytes(&signature).ok_or_else(|| {
            BillingError::bad_webhook("Lemon Squeezy webhook signature is invalid")
        })?;
        mac.verify_slice(&provided).map_err(|_| {
            BillingError::bad_webhook("Lemon Squeezy webhook signature verification failed")
        })
    }
}

pub async fn create_checkout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CheckoutRequest>,
) -> Response {
    let Some(billing) = state.billing.as_ref() else {
        return BillingError::unavailable("Billing is not enabled").into_response();
    };
    if state.cloud_db.is_none() {
        return BillingError::unavailable("Billing database is not available").into_response();
    }
    let user = match current_session_user(&state, &headers).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            return BillingError::unauthorized("Sign in is required for paid checkout")
                .into_response()
        }
        Err(error) => return error.into_response(),
    };

    match billing.create_checkout(request, &user).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.into_response(),
    }
}

pub async fn capture_checkout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CaptureRequest>,
) -> Response {
    let Some(billing) = state.billing.as_ref() else {
        return BillingError::unavailable("Billing is not enabled").into_response();
    };
    let Some(database) = state.cloud_db.as_ref() else {
        return BillingError::unavailable("Billing database is not available").into_response();
    };
    let user = match current_session_user(&state, &headers).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            return BillingError::unauthorized("Sign in is required for paid checkout")
                .into_response()
        }
        Err(error) => return error.into_response(),
    };

    match billing
        .capture_order(database, &request.order_id, &user)
        .await
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.into_response(),
    }
}

pub async fn paypal_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(billing) = state.billing.as_ref() else {
        return BillingError::unavailable("Billing is not enabled").into_response();
    };
    let Some(database) = state.cloud_db.as_ref() else {
        return BillingError::unavailable("Billing database is not available").into_response();
    };

    let event = match serde_json::from_slice::<Value>(&body) {
        Ok(event) => event,
        Err(error) => return BillingError::bad_webhook(error.to_string()).into_response(),
    };
    if let Err(error) = billing.validate_webhook(&headers, &event).await {
        return error.into_response();
    }

    match process_paypal_event(database, &event).await {
        Ok(()) => Json(json!({ "received": true })).into_response(),
        Err(error) => error.into_response(),
    }
}

pub async fn lemonsqueezy_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(billing) = state.billing.as_ref() else {
        return BillingError::unavailable("Billing is not enabled").into_response();
    };
    let Some(database) = state.cloud_db.as_ref() else {
        return BillingError::unavailable("Billing database is not available").into_response();
    };

    if let Err(error) = billing.validate_lemonsqueezy_webhook(&headers, &body) {
        return error.into_response();
    }
    let event = match serde_json::from_slice::<Value>(&body) {
        Ok(event) => event,
        Err(error) => return BillingError::bad_webhook(error.to_string()).into_response(),
    };

    match process_lemonsqueezy_event(database, &headers, &event).await {
        Ok(()) => Json(json!({ "received": true })).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn process_lemonsqueezy_event(
    database: &CloudDatabase,
    headers: &HeaderMap,
    event: &Value,
) -> Result<(), BillingError> {
    let event_type = headers
        .get("x-event-name")
        .and_then(|value| value.to_str().ok())
        .or_else(|| event.pointer("/meta/event_name").and_then(Value::as_str))
        .ok_or_else(|| BillingError::bad_webhook("Lemon Squeezy event is missing event name"))?;
    let resource_id = event
        .pointer("/data/id")
        .and_then(Value::as_str)
        .ok_or_else(|| BillingError::bad_webhook("Lemon Squeezy event is missing resource id"))?;
    let event_id = format!("{event_type}:{resource_id}");
    let event_created = unix_now();

    let is_new = database
        .try_record_lemonsqueezy_event(&event_id, event_type, event_created, unix_now())
        .await
        .map_err(BillingError::internal)?;
    if !is_new {
        return Ok(());
    }

    match event_type {
        "order_created" => process_lemonsqueezy_order(database, event, event_created).await?,
        "subscription_created" | "subscription_updated" => {
            process_lemonsqueezy_subscription(database, event, event_created).await?
        }
        "subscription_cancelled" | "subscription_expired" | "subscription_paused" => {
            set_lemonsqueezy_subscription_inactive(database, event, event_created).await?
        }
        "subscription_resumed" => {
            process_lemonsqueezy_subscription(database, event, event_created).await?
        }
        _ => {}
    }

    Ok(())
}

async fn process_lemonsqueezy_order(
    database: &CloudDatabase,
    event: &Value,
    created_at: u64,
) -> Result<(), BillingError> {
    let status = event
        .pointer("/data/attributes/status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if status != "paid" {
        return Ok(());
    }
    let sku = custom_data_string(event, "sku")
        .ok_or_else(|| BillingError::bad_webhook("Lemon Squeezy order is missing sku"))?;
    let Some(plan) = paid_plan(&sku) else {
        return Err(BillingError::bad_webhook(
            "Lemon Squeezy order has unknown sku",
        ));
    };
    if plan.checkout_mode != CheckoutMode::Payment {
        return Ok(());
    }
    let checkout_ref = custom_data_string(event, "checkout_ref").ok_or_else(|| {
        BillingError::bad_webhook("Lemon Squeezy order is missing checkout reference")
    })?;
    let user_id =
        custom_data_string(event, "user_id").and_then(|value| Uuid::parse_str(&value).ok());
    let order_id = event
        .pointer("/data/id")
        .and_then(Value::as_str)
        .ok_or_else(|| BillingError::bad_webhook("Lemon Squeezy order is missing id"))?;
    let email = event
        .pointer("/data/attributes/user_email")
        .and_then(Value::as_str);

    database
        .upsert_lemonsqueezy_order_entitlement(LemonSqueezyOrderEntitlementInput {
            lemonsqueezy_order_id: order_id,
            lemonsqueezy_checkout_ref: &checkout_ref,
            user_id,
            email,
            sku: plan.sku,
            max_total_bytes: plan.max_total_bytes,
            max_file_bytes: plan.max_file_bytes,
            retention_seconds: plan.retention_seconds,
            created_at,
        })
        .await
        .map_err(BillingError::internal)?;

    Ok(())
}

async fn process_lemonsqueezy_subscription(
    database: &CloudDatabase,
    event: &Value,
    created_at: u64,
) -> Result<(), BillingError> {
    let sku =
        custom_data_string(event, "sku").unwrap_or_else(|| "pro_monthly_krw_9900".to_string());
    let Some(plan) = paid_plan(&sku) else {
        return Err(BillingError::bad_webhook(
            "Lemon Squeezy subscription has unknown sku",
        ));
    };
    if plan.checkout_mode != CheckoutMode::Subscription {
        return Ok(());
    }
    let subscription_id = event
        .pointer("/data/id")
        .and_then(Value::as_str)
        .ok_or_else(|| BillingError::bad_webhook("Lemon Squeezy subscription is missing id"))?;
    let raw_status = event
        .pointer("/data/attributes/status")
        .and_then(Value::as_str)
        .unwrap_or("inactive");
    let user_id =
        custom_data_string(event, "user_id").and_then(|value| Uuid::parse_str(&value).ok());
    let email = event
        .pointer("/data/attributes/user_email")
        .and_then(Value::as_str);
    let checkout_ref = custom_data_string(event, "checkout_ref");
    let variant_id = event
        .pointer("/data/attributes/variant_id")
        .and_then(value_to_string);
    let customer_id = event
        .pointer("/data/attributes/customer_id")
        .and_then(value_to_string);
    let payment_update_url = event
        .pointer("/data/attributes/urls/update_payment_method")
        .and_then(Value::as_str);

    database
        .upsert_lemonsqueezy_subscription_entitlement(LemonSqueezySubscriptionEntitlementInput {
            lemonsqueezy_subscription_id: subscription_id,
            lemonsqueezy_checkout_ref: checkout_ref.as_deref(),
            lemonsqueezy_variant_id: variant_id.as_deref(),
            lemonsqueezy_customer_id: customer_id.as_deref(),
            payment_update_url,
            status: lemonsqueezy_subscription_status(raw_status),
            user_id,
            email,
            current_period_start: None,
            current_period_end: None,
            created_at,
        })
        .await
        .map_err(BillingError::internal)?;

    Ok(())
}

async fn set_lemonsqueezy_subscription_inactive(
    database: &CloudDatabase,
    event: &Value,
    updated_at: u64,
) -> Result<(), BillingError> {
    let subscription_id = event
        .pointer("/data/id")
        .and_then(Value::as_str)
        .ok_or_else(|| BillingError::bad_webhook("Lemon Squeezy subscription is missing id"))?;
    database
        .set_lemonsqueezy_subscription_status(subscription_id, "inactive", updated_at)
        .await
        .map_err(BillingError::internal)?;
    Ok(())
}

async fn process_paypal_event(database: &CloudDatabase, event: &Value) -> Result<(), BillingError> {
    let event_id = event
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| BillingError::bad_webhook("PayPal event is missing id"))?;
    let event_type = event
        .get("event_type")
        .and_then(Value::as_str)
        .ok_or_else(|| BillingError::bad_webhook("PayPal event is missing event_type"))?;
    let event_created = unix_now();

    let is_new = database
        .try_record_paypal_event(event_id, event_type, event_created, unix_now())
        .await
        .map_err(BillingError::internal)?;
    if !is_new {
        return Ok(());
    }

    let resource = event
        .get("resource")
        .ok_or_else(|| BillingError::bad_webhook("PayPal event is missing resource"))?;

    match event_type {
        "BILLING.SUBSCRIPTION.ACTIVATED" => {
            let subscription_id = resource
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| BillingError::bad_webhook("PayPal subscription is missing id"))?;
            let custom_id = resource
                .get("custom_id")
                .and_then(Value::as_str)
                .unwrap_or("pro_monthly_krw_9900");
            let (sku, user_id) = parse_subscription_custom_id(custom_id);
            if paid_plan(sku).is_none() {
                return Err(BillingError::bad_webhook(
                    "PayPal subscription has unknown sku",
                ));
            }
            let email = resource
                .pointer("/subscriber/email_address")
                .and_then(Value::as_str);
            let paypal_plan_id = resource.get("plan_id").and_then(Value::as_str);

            database
                .upsert_paypal_subscription_entitlement(PayPalSubscriptionEntitlementInput {
                    paypal_subscription_id: subscription_id,
                    paypal_plan_id,
                    user_id,
                    email,
                    created_at: event_created,
                })
                .await
                .map_err(BillingError::internal)?;
        }
        "BILLING.SUBSCRIPTION.CANCELLED"
        | "BILLING.SUBSCRIPTION.SUSPENDED"
        | "BILLING.SUBSCRIPTION.EXPIRED" => {
            let subscription_id = resource
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| BillingError::bad_webhook("PayPal subscription is missing id"))?;
            database
                .set_paypal_subscription_status(subscription_id, "inactive", event_created)
                .await
                .map_err(BillingError::internal)?;
        }
        _ => {}
    }

    Ok(())
}

#[derive(Clone, Copy)]
struct PaidPlan {
    sku: &'static str,
    label: &'static str,
    price_krw: u64,
    max_total_bytes: u64,
    max_file_bytes: u64,
    retention_seconds: u64,
    checkout_mode: CheckoutMode,
}

fn paid_plan(sku: &str) -> Option<PaidPlan> {
    const GB: u64 = 1024 * 1024 * 1024;
    const TB: u64 = 1024 * GB;
    match sku {
        "drop_100gb_3d" => Some(PaidPlan {
            sku: "drop_100gb_3d",
            label: "100GB Drop Pass",
            price_krw: 1_900,
            max_total_bytes: 100 * GB,
            max_file_bytes: 100 * GB,
            retention_seconds: 3 * 24 * 60 * 60,
            checkout_mode: CheckoutMode::Payment,
        }),
        "drop_500gb_7d" => Some(PaidPlan {
            sku: "drop_500gb_7d",
            label: "500GB Drop Pass",
            price_krw: 4_900,
            max_total_bytes: 500 * GB,
            max_file_bytes: 500 * GB,
            retention_seconds: 7 * 24 * 60 * 60,
            checkout_mode: CheckoutMode::Payment,
        }),
        "drop_1tb_7d" => Some(PaidPlan {
            sku: "drop_1tb_7d",
            label: "1TB Drop Pass",
            price_krw: 9_900,
            max_total_bytes: TB,
            max_file_bytes: TB,
            retention_seconds: 7 * 24 * 60 * 60,
            checkout_mode: CheckoutMode::Payment,
        }),
        "pro_monthly_krw_9900" => Some(PaidPlan {
            sku: "pro_monthly_krw_9900",
            label: "PonsWarp Pro",
            price_krw: 9_900,
            max_total_bytes: TB,
            max_file_bytes: TB,
            retention_seconds: 7 * 24 * 60 * 60,
            checkout_mode: CheckoutMode::Subscription,
        }),
        _ => None,
    }
}

impl PaidPlan {
    fn paypal_amount(&self, currency: &str) -> String {
        match currency {
            "KRW" => self.price_krw.to_string(),
            "USD" => format!("{:.2}", self.price_krw as f64 / 1000.0),
            _ => self.price_krw.to_string(),
        }
    }
}

impl CheckoutMode {
    fn as_str(self) -> &'static str {
        match self {
            CheckoutMode::Payment => "payment",
            CheckoutMode::Subscription => "subscription",
        }
    }
}

fn parse_provider(value: &str) -> Result<CheckoutProvider> {
    match value.trim().to_ascii_lowercase().as_str() {
        "lemonsqueezy" | "lemon_squeezy" | "lemon-squeezy" | "lemon" => {
            Ok(CheckoutProvider::LemonSqueezy)
        }
        "paypal" | "pay_pal" | "pay-pal" => Ok(CheckoutProvider::PayPal),
        other => bail!("unsupported payment provider: {other}"),
    }
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn approval_url(value: &Value) -> Result<String, BillingError> {
    value
        .get("links")
        .and_then(Value::as_array)
        .and_then(|links| {
            links.iter().find_map(|link| {
                let rel = link.get("rel").and_then(Value::as_str);
                if rel == Some("approve") || rel == Some("payer-action") {
                    link.get("href").and_then(Value::as_str)
                } else {
                    None
                }
            })
        })
        .map(str::to_string)
        .ok_or_else(|| BillingError::internal("PayPal did not return an approval URL"))
}

fn required_header(headers: &HeaderMap, name: &'static str) -> Result<String, BillingError> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| BillingError::bad_webhook(format!("Missing {name} header")))
}

fn append_query(url: &str, query: &str) -> String {
    if url.contains('?') {
        format!("{url}&{query}")
    } else {
        format!("{url}?{query}")
    }
}

fn url_query_value(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn url_path(value: &str) -> String {
    value.replace('/', "%2F")
}

fn capture_request_id(order_id: &str) -> String {
    format!("ponswarp-capture-{order_id}")
}

fn subscription_custom_id(sku: &str, user_id: uuid::Uuid) -> String {
    format!("{sku}|{user_id}")
}

fn parse_subscription_custom_id(value: &str) -> (&str, Option<uuid::Uuid>) {
    let Some((sku, user_id)) = value.split_once('|') else {
        return (value, None);
    };
    (sku, uuid::Uuid::parse_str(user_id).ok())
}

fn custom_data_string(event: &Value, key: &str) -> Option<String> {
    event
        .pointer(&format!("/meta/custom_data/{key}"))
        .and_then(value_to_string)
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn lemonsqueezy_subscription_status(status: &str) -> &'static str {
    match status {
        "active" | "on_trial" => "active",
        _ => "inactive",
    }
}

fn hex_to_bytes(value: &str) -> Option<Vec<u8>> {
    let value = value.trim();
    if !value.len().is_multiple_of(2) {
        return None;
    }

    let mut bytes = Vec::with_capacity(value.len() / 2);
    for chunk in value.as_bytes().chunks_exact(2) {
        let high = hex_value(chunk[0])?;
        let low = hex_value(chunk[1])?;
        bytes.push((high << 4) | low);
    }
    Some(bytes)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug)]
struct BillingError {
    status: StatusCode,
    message: String,
}

impl BillingError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn bad_webhook(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(error = %error, "Billing error");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "Billing request failed".to_string(),
        }
    }
}

impl IntoResponse for BillingError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(BillingErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_query_adds_first_query_parameter() {
        assert_eq!(
            append_query("https://warp.ponslink.com", "checkout=success"),
            "https://warp.ponslink.com?checkout=success"
        );
    }

    #[test]
    fn append_query_preserves_existing_query_parameters() {
        assert_eq!(
            append_query(
                "https://warp.ponslink.com/cloud?mode=drop",
                "checkout=success"
            ),
            "https://warp.ponslink.com/cloud?mode=drop&checkout=success"
        );
    }

    #[test]
    fn paid_plan_modes_match_checkout_kind() {
        assert_eq!(
            paid_plan("drop_1tb_7d").unwrap().checkout_mode,
            CheckoutMode::Payment
        );
        assert_eq!(
            paid_plan("pro_monthly_krw_9900").unwrap().checkout_mode,
            CheckoutMode::Subscription
        );
    }

    #[test]
    fn paypal_amount_formats_configured_currency() {
        let plan = paid_plan("pro_monthly_krw_9900").unwrap();

        assert_eq!(plan.paypal_amount("KRW"), "9900");
        assert_eq!(plan.paypal_amount("USD"), "9.90");
    }

    #[test]
    fn capture_request_id_is_stable_for_order_retries() {
        assert_eq!(
            capture_request_id("5O190127TN364715T"),
            "ponswarp-capture-5O190127TN364715T"
        );
    }

    #[test]
    fn approval_url_accepts_payer_action_links() {
        let value = json!({
            "links": [
                {
                    "rel": "payer-action",
                    "href": "https://www.sandbox.paypal.com/checkoutnow?token=test"
                }
            ]
        });

        assert_eq!(
            approval_url(&value).unwrap(),
            "https://www.sandbox.paypal.com/checkoutnow?token=test"
        );
    }
}
