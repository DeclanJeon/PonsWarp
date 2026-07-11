//! WebRTC 시그널링 핸들러

use crate::protocol::ServerMessage;
use crate::state::AppState;
use std::sync::Arc;

/// Offer 처리
pub async fn handle_offer(
    state: Arc<AppState>,
    from_peer_id: &str,
    room_id: &str,
    sdp: &str,
    target: Option<&str>,
) {
    let message = ServerMessage::Offer {
        from: from_peer_id.to_string(),
        sdp: sdp.to_string(),
    };

    if let Some(target_id) = target {
        send_to_peer(&state, target_id, message).await;
    } else {
        broadcast_to_room_except(&state, room_id, from_peer_id, message).await;
    }

    tracing::debug!(
        from = %from_peer_id,
        room_id = %room_id,
        target = ?target,
        "Relayed offer"
    );
}

/// Answer 처리
pub async fn handle_answer(
    state: Arc<AppState>,
    from_peer_id: &str,
    room_id: &str,
    sdp: &str,
    target: Option<&str>,
) {
    let message = ServerMessage::Answer {
        from: from_peer_id.to_string(),
        sdp: sdp.to_string(),
    };

    if let Some(target_id) = target {
        send_to_peer(&state, target_id, message).await;
    } else {
        broadcast_to_room_except(&state, room_id, from_peer_id, message).await;
    }

    tracing::debug!(
        from = %from_peer_id,
        room_id = %room_id,
        target = ?target,
        "Relayed answer"
    );
}

/// ICE Candidate 처리
pub async fn handle_ice_candidate(
    state: Arc<AppState>,
    from_peer_id: &str,
    room_id: &str,
    candidate: &str,
    target: Option<&str>,
) {
    let message = ServerMessage::IceCandidate {
        from: from_peer_id.to_string(),
        candidate: candidate.to_string(),
    };

    if let Some(target_id) = target {
        send_to_peer(&state, target_id, message).await;
    } else {
        broadcast_to_room_except(&state, room_id, from_peer_id, message).await;
    }

    tracing::debug!(
        from = %from_peer_id,
        room_id = %room_id,
        target = ?target,
        "Relayed ICE candidate"
    );
}

/// Manifest 처리 (Native QUIC 모드용)
pub async fn handle_manifest(
    state: Arc<AppState>,
    from_peer_id: &str,
    room_id: &str,
    manifest: &str,
    target: Option<&str>,
) {
    let message = ServerMessage::Manifest {
        from: from_peer_id.to_string(),
        manifest: manifest.to_string(),
    };

    if let Some(target_id) = target {
        send_to_peer(&state, target_id, message).await;
    } else {
        broadcast_to_room_except(&state, room_id, from_peer_id, message).await;
    }

    tracing::info!(
        from = %from_peer_id,
        room_id = %room_id,
        target = ?target,
        "Relayed manifest"
    );
}

/// 🆕 TransferReady 처리 (Receiver -> Sender)
pub async fn handle_transfer_ready(
    state: Arc<AppState>,
    from_peer_id: &str,
    room_id: &str,
    target: Option<&str>,
) {
    let message = ServerMessage::TransferReady {
        from: from_peer_id.to_string(),
    };

    if let Some(target_id) = target {
        send_to_peer(&state, target_id, message).await;
    } else {
        broadcast_to_room_except(&state, room_id, from_peer_id, message).await;
    }

    tracing::info!(
        from = %from_peer_id,
        room_id = %room_id,
        target = ?target,
        "Relayed transfer ready"
    );
}

/// 🆕 TransferComplete 처리 (Receiver -> Sender)
/// 🚀 [고속 중계] 우선순위가 높은 완료 신호 처리
pub async fn handle_transfer_complete(
    state: Arc<AppState>,
    from_peer_id: &str,
    room_id: &str,
    target: Option<&str>,
) {
    // 🚀 [고속 중계] 불필요한 로깅 최소화로 지연 감소
    // tracing::debug!(
    //     from = %from_peer_id,
    //     room_id = %room_id,
    //     target = ?target,
    //     "Processing transfer complete"
    // );

    let message = ServerMessage::TransferComplete {
        from: from_peer_id.to_string(),
    };

    // 🚀 [고속 중계] 즉시 전송 - 타겟이 명시된 경우 직접 전송
    if let Some(target_id) = target {
        // 🚀 [고속 중계] 비동기 전송으로 블로킹 방지
        if let Some(peer_session) = state.peers.get(target_id) {
            let forward_msg = ServerMessage::TransferComplete {
                from: from_peer_id.to_string(),
            };

            // 🚀 [고속 중계] send로 블로킹 없이 전송 시도
            // UnboundedSender는 블로킹하지 않으므로 try_send 대신 send 사용
            if let Err(e) = peer_session.sender.send(forward_msg) {
                tracing::warn!("Failed to send transfer complete to {}: {}", target_id, e);
            } else {
                tracing::info!(
                    from = %from_peer_id,
                    to = %target_id,
                    "Transfer complete relayed (fast track)"
                );
            }
        }
    } else {
        // 🚀 [고속 중계] 브로드캐스트는 비동기로 처리
        // 라이프타임 문제를 해결하기 위해 문자열을 소유권으로 복제
        let room_id_owned = room_id.to_string();
        let from_peer_id_owned = from_peer_id.to_string();
        let state_clone = state.clone();

        tokio::spawn(async move {
            broadcast_to_room_except(&state_clone, &room_id_owned, &from_peer_id_owned, message)
                .await;
        });
    }

    // 🚀 [고속 중계] 완료 신호는 즉시 처리해야 하므로 로깅 최소화
    tracing::info!(
        from = %from_peer_id,
        room_id = %room_id,
        target = ?target,
        "Transfer complete relayed"
    );
}

/// 특정 피어에게 메시지 전송
async fn send_to_peer(state: &AppState, peer_id: &str, message: ServerMessage) {
    if let Some(session) = state.peers.get(peer_id) {
        let _ = session.sender.send(message);
    }
}

/// 방의 특정 피어를 제외하고 브로드캐스트
async fn broadcast_to_room_except(
    state: &AppState,
    room_id: &str,
    except_peer_id: &str,
    message: ServerMessage,
) {
    if let Some(room) = state.rooms.get(room_id) {
        let users = room.users.read().await;
        for peer_id in users.iter() {
            if peer_id != except_peer_id {
                if let Some(session) = state.peers.get(peer_id) {
                    let _ = session.sender.send(message.clone());
                }
            }
        }
    }
}
