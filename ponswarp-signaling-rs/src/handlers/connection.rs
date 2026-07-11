//! 연결 핸들러

use crate::protocol::ServerMessage;
use crate::state::{AppState, PeerSession};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc::UnboundedSender, RwLock};
use uuid::Uuid;

/// 새 연결 처리
pub async fn handle_connection(
    state: Arc<AppState>,
    sender: UnboundedSender<ServerMessage>,
) -> String {
    let peer_id = Uuid::new_v4().to_string();

    let session = PeerSession {
        id: peer_id.clone(),
        room_id: RwLock::new(None),
        sender: sender.clone(),
        connected_at: Instant::now(),
    };

    state.peers.insert(peer_id.clone(), session);

    let _ = sender.send(ServerMessage::Connected {
        socket_id: peer_id.clone(),
    });

    tracing::info!(peer_id = %peer_id, "New connection established");
    peer_id
}

/// 연결 해제 처리
pub async fn handle_disconnect(state: Arc<AppState>, peer_id: &str) {
    if let Some((_, session)) = state.peers.remove(peer_id) {
        let room_id = session.room_id.read().await.clone();
        if let Some(room_id) = room_id {
            crate::handlers::room::leave_room_internal(&state, peer_id, &room_id).await;
        }
    }
    tracing::info!(peer_id = %peer_id, "Connection closed");
}

/// Heartbeat 처리
pub fn handle_heartbeat(sender: &UnboundedSender<ServerMessage>) {
    let _ = sender.send(ServerMessage::HeartbeatAck);
}
