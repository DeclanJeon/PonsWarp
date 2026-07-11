//! PonsWarp Rust 시그널링 서버

use anyhow::{Context, Result};
use axum::http::StatusCode;
use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::{Html, IntoResponse, Json},
    routing::{get, post},
    Router,
};
use futures::{SinkExt, StreamExt};
use ponswarp_signaling_rs::{
    admin, auth, billing,
    config::{cors_layer, Config},
    handlers, mesh,
    protocol::{ClientMessage, ServerMessage},
    state::AppState,
};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config::from_env();
    if !config.mesh.enabled {
        tracing::warn!(
            "PONSWARP_MESH_ENABLED=false; mesh coordinator routes will report disabled readiness"
        );
    }

    // 로깅 초기화
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(&config.log_level))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let state = Arc::new(AppState::new(config.clone()).await?);

    // 방 정리 스케줄러
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(300));
        loop {
            interval.tick().await;
            handlers::cleanup_old_rooms(cleanup_state.clone()).await;
        }
    });

    // R2 임시 공유 정리 스케줄러
    let cloud_cleanup_state = state.clone();
    let cloud_cleanup_interval_seconds = config.cloud.cleanup_interval_seconds.max(60);
    let cloud_cleanup_run_on_startup = config.cloud.cleanup_run_on_startup;
    tokio::spawn(async move {
        if cloud_cleanup_run_on_startup {
            handlers::cleanup_expired_cloud_shares(cloud_cleanup_state.clone()).await;
        }
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(
            cloud_cleanup_interval_seconds,
        ));
        loop {
            interval.tick().await;
            handlers::cleanup_expired_cloud_shares(cloud_cleanup_state.clone()).await;
        }
    });
    // Mesh retention cleanup scheduler
    if config.mesh.enabled && config.mesh.cleanup_run_on_startup {
        let report = mesh::cleanup_mesh_retention(&state, current_unix_seconds()).await?;
        tracing::info!(?report, "mesh retention cleanup completed on startup");
    }
    if config.mesh.enabled && config.mesh.cleanup_interval_seconds > 0 {
        spawn_mesh_cleanup_worker(state.clone(), config.mesh.cleanup_interval_seconds);
    }

    // CORS 설정
    let cors = cors_layer(&config)?;

    let app = signaling_router(state.clone(), cors);

    let addr = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("failed to bind {addr}"))?;

    tracing::info!("🚀 PonsWarp Rust Signaling Server started");
    tracing::info!("Address: {}", addr);
    tracing::info!("WebSocket: ws://{}/ws", addr);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .context("server failed")?;
    Ok(())
}

fn spawn_mesh_cleanup_worker(state: Arc<AppState>, interval_seconds: u64) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_seconds));
        loop {
            interval.tick().await;
            match mesh::cleanup_mesh_retention(&state, current_unix_seconds()).await {
                Ok(report) => tracing::info!(?report, "mesh retention cleanup completed"),
                Err(error) => tracing::warn!(%error, "mesh retention cleanup failed"),
            }
        }
    });
}

fn current_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn signaling_router(state: Arc<AppState>, cors: tower_http::cors::CorsLayer) -> Router {
    Router::new()
        .route("/", get(index_handler))
        .route("/health", get(health_handler))
        .route("/ready", get(readiness_handler))
        .route("/ws", get(ws_handler))
        .route("/api/cloud-plans", get(handlers::get_cloud_plans))
        .route("/api/auth/me", get(auth::me))
        .route("/api/auth/google/start", get(auth::google_start))
        .route("/api/auth/google/callback", get(auth::google_callback))
        .route("/auth/google/callback", get(auth::google_callback))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/admin/me", get(admin::me))
        .route("/api/admin/overview", get(admin::overview))
        .route("/api/admin/operations", get(admin::operations))
        .route("/api/cloud-share", post(handlers::create_cloud_share))
        .route("/api/billing/checkout", post(billing::create_checkout))
        .route("/api/billing/capture", post(billing::capture_checkout))
        .route("/api/billing/webhook", post(billing::paypal_webhook))
        .route("/api/billing/paypal/webhook", post(billing::paypal_webhook))
        .route(
            "/api/billing/lemonsqueezy/webhook",
            post(billing::lemonsqueezy_webhook),
        )
        .route(
            "/api/cloud-share/:share_id",
            get(handlers::get_cloud_share).post(handlers::access_cloud_share),
        )
        .route(
            "/api/cloud-share/:share_id/complete",
            post(handlers::complete_cloud_share),
        )
        .route(
            "/api/cloud-share/:share_id/abort",
            post(handlers::abort_cloud_share_uploads),
        )
        .route(
            "/api/cloud-share/:share_id/files/:file_id/download",
            get(handlers::download_cloud_file),
        )
        .merge(mesh::legacy_mesh_router())
        .merge(mesh::mesh_api_v1_router())
        .layer(cors)
        .with_state(state)
}

async fn index_handler() -> Html<&'static str> {
    Html("<h1>PonsWarp Signaling Server (Rust)</h1><p>WebSocket endpoint: /ws</p>")
}

async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "server": "ponswarp-signaling-rs",
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }))
}

async fn readiness_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let cloud_ready = !state.config.cloud.enabled || state.cloud.is_some();
    let billing_ready = !state.config.cloud.billing_enabled || state.cloud_db.is_some();
    let ready = cloud_ready && billing_ready;
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (
        status,
        Json(serde_json::json!({
            "status": if ready { "ready" } else { "not_ready" },
            "cloudShare": cloud_ready,
            "billing": billing_ready,
        })),
    )
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();

    // 연결 처리
    let peer_id = handlers::handle_connection(state.clone(), tx.clone()).await;

    // 송신 태스크
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                if ws_sender.send(Message::Text(json)).await.is_err() {
                    break;
                }
            }
        }
    });

    // 수신 처리
    let state_clone = state.clone();
    let peer_id_clone = peer_id.clone();
    let tx_clone = tx.clone();

    while let Some(result) = ws_receiver.next().await {
        match result {
            Ok(Message::Text(text)) => {
                if let Ok(msg) = serde_json::from_str::<ClientMessage>(&text) {
                    handle_client_message(&state_clone, &peer_id_clone, &tx_clone, msg).await;
                }
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    // 연결 해제
    handlers::handle_disconnect(state, &peer_id).await;
    send_task.abort();
}

async fn handle_client_message(
    state: &Arc<AppState>,
    peer_id: &str,
    sender: &mpsc::UnboundedSender<ServerMessage>,
    msg: ClientMessage,
) {
    match msg {
        ClientMessage::Heartbeat => {
            handlers::handle_heartbeat(sender);
        }
        ClientMessage::JoinRoom { room_id } => {
            handlers::handle_join_room(state.clone(), peer_id, &room_id).await;
        }
        ClientMessage::LeaveRoom => {
            handlers::handle_leave_room(state.clone(), peer_id).await;
        }
        ClientMessage::Offer {
            room_id,
            sdp,
            target,
        } => {
            handlers::handle_offer(state.clone(), peer_id, &room_id, &sdp, target.as_deref()).await;
        }
        ClientMessage::Answer {
            room_id,
            sdp,
            target,
        } => {
            handlers::handle_answer(state.clone(), peer_id, &room_id, &sdp, target.as_deref())
                .await;
        }
        ClientMessage::IceCandidate {
            room_id,
            candidate,
            target,
        } => {
            handlers::handle_ice_candidate(
                state.clone(),
                peer_id,
                &room_id,
                &candidate,
                target.as_deref(),
            )
            .await;
        }
        ClientMessage::Manifest {
            room_id,
            manifest,
            target,
        } => {
            handlers::handle_manifest(
                state.clone(),
                peer_id,
                &room_id,
                &manifest,
                target.as_deref(),
            )
            .await;
        }
        ClientMessage::TransferReady { room_id, target } => {
            handlers::handle_transfer_ready(state.clone(), peer_id, &room_id, target.as_deref())
                .await;
        }
        ClientMessage::TransferComplete { room_id, target } => {
            handlers::handle_transfer_complete(state.clone(), peer_id, &room_id, target.as_deref())
                .await;
        }
        ClientMessage::RequestTurnConfig { room_id, .. } => {
            handlers::handle_turn_config_request(state.clone(), sender, &room_id).await;
        }
        ClientMessage::RefreshTurnCredentials {
            room_id,
            current_username,
        } => {
            if handlers::validate_credentials(&current_username) {
                let _ = sender.send(ServerMessage::TurnConfig {
                    success: true,
                    data: None,
                    error: Some("Credentials still valid".to_string()),
                });
            } else {
                handlers::handle_turn_config_request(state.clone(), sender, &room_id).await;
            }
        }
        ClientMessage::CheckTurnServerStatus => {
            let _ = sender.send(ServerMessage::TurnServerStatusUpdate {
                room_id: String::new(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            });
        }
    }
}
