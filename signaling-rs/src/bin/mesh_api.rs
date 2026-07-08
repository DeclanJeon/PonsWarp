use anyhow::{Context, Result};
use ponswarp_signaling_rs::{
    config::{cors_layer, Config},
    mesh::{self, cleanup_mesh_retention},
    state::AppState,
};
use std::sync::Arc;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config::from_env();
    if !config.mesh.enabled {
        tracing::warn!(
            "PONSWARP_MESH_ENABLED=false; mesh coordinator API will report disabled readiness"
        );
    }

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(&config.log_level))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let state = Arc::new(AppState::new_mesh_coordinator(config.clone()).await?);
    if config.mesh.enabled && config.mesh.cleanup_run_on_startup {
        let report = cleanup_mesh_retention(&state, current_unix_seconds()).await?;
        tracing::info!(?report, "mesh retention cleanup completed on startup");
    }

    if config.mesh.enabled && config.mesh.cleanup_interval_seconds > 0 {
        spawn_mesh_cleanup_worker(state.clone(), config.mesh.cleanup_interval_seconds);
    }

    let cors = cors_layer(&config)?;
    let app = mesh::mesh_api_router().layer(cors).with_state(state);

    let addr = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("failed to bind mesh coordinator at {addr}"))?;

    tracing::info!("PonsWarp Mesh Coordinator started");
    tracing::info!("Address: {}", addr);
    tracing::info!("Mesh API prefix: /api/mesh/v1");

    axum::serve(listener, app)
        .await
        .context("mesh coordinator failed")?;
    Ok(())
}

fn spawn_mesh_cleanup_worker(state: Arc<AppState>, interval_seconds: u64) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_seconds));
        loop {
            interval.tick().await;
            match cleanup_mesh_retention(&state, current_unix_seconds()).await {
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
