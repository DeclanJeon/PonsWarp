//! 방 관리 핸들러

use crate::protocol::ServerMessage;
use crate::state::{AppState, Room};
use std::sync::Arc;
use std::time::Instant;

/// 방 참여 처리
pub async fn handle_join_room(state: Arc<AppState>, peer_id: &str, room_id: &str) {
    let room_id = room_id.trim().to_string();
    let max_size = state.config.room.max_size;

    tracing::info!(peer_id = %peer_id, room_id = %room_id, "handle_join_room started");

    // 방 가져오기 또는 생성 및 로직 처리 (스코프 제한으로 Deadlock 방지)
    let updated_users = {
        tracing::info!(room_id = %room_id, "Acquiring room lock...");
        let room = state.rooms.entry(room_id.clone()).or_insert_with(|| {
            tracing::info!(room_id = %room_id, "Room created");
            Room::new(room_id.clone())
        });
        tracing::info!(room_id = %room_id, "Room lock acquired");

        // 방 인원 제한 확인 (이미 방에 있는 유저가 재접속하는 경우는 허용)
        {
            let users = room.users.read().await;
            // !users.contains(peer_id) 조건을 통해,
            // 이미 방 목록에 내 ID가 있다면(재접속 등) RoomFull을 띄우지 않음
            if users.len() >= max_size && !users.contains(peer_id) {
                if let Some(session) = state.peers.get(peer_id) {
                    let _ = session.sender.send(ServerMessage::RoomFull {
                        room_id: room_id.clone(),
                    });
                }
                tracing::warn!(room_id = %room_id, "Room full, rejected join");
                return;
            }
        }

        // 기존 사용자 목록
        let existing_users: Vec<String> = room.users.read().await.iter().cloned().collect();
        tracing::info!(room_id = %room_id, existing_users = ?existing_users, "Got existing users");

        // 방에 참여
        room.users.write().await.insert(peer_id.to_string());
        tracing::info!(room_id = %room_id, peer_id = %peer_id, "User inserted into room");

        // 피어 세션 업데이트
        if let Some(session) = state.peers.get(peer_id) {
            *session.room_id.write().await = Some(room_id.clone());
        }

        let user_count = room.users.read().await.len();

        // 새 사용자에게 기존 사용자 목록 전송
        if let Some(session) = state.peers.get(peer_id) {
            let _ = session.sender.send(ServerMessage::RoomUsers {
                users: existing_users.clone(),
            });
            let _ = session.sender.send(ServerMessage::JoinedRoom {
                room_id: room_id.clone(),
                socket_id: peer_id.to_string(),
                user_count,
            });
            tracing::info!(peer_id = %peer_id, "Sent JoinedRoom to new user");
        }

        // 기존 사용자들에게 새 사용자 알림
        for existing_peer_id in &existing_users {
            if let Some(session) = state.peers.get(existing_peer_id) {
                let _ = session.sender.send(ServerMessage::PeerJoined {
                    socket_id: peer_id.to_string(),
                    room_id: room_id.clone(),
                });
                tracing::info!(target = %existing_peer_id, "Sent PeerJoined notification");
            }
        }

        // 업데이트된 사용자 목록 반환
        let users_list = room
            .users
            .read()
            .await
            .iter()
            .cloned()
            .collect::<Vec<String>>();
        users_list
    }; // 여기서 room (DashMap RefMut)이 드롭되어 락이 해제됨

    tracing::info!(room_id = %room_id, "Room lock released, broadcasting RoomUsers");

    let user_count = updated_users.len();

    // 모든 사용자에게 업데이트된 목록 브로드캐스트 (락 해제 후 호출)
    broadcast_to_room(
        &state,
        &room_id,
        ServerMessage::RoomUsers {
            users: updated_users,
        },
    )
    .await;

    tracing::info!(room_id = %room_id, "handle_join_room completed");

    tracing::info!(
        peer_id = %peer_id,
        room_id = %room_id,
        user_count = user_count,
        "User joined room"
    );
}

/// 방 나가기 내부 로직
pub async fn leave_room_internal(state: &AppState, peer_id: &str, room_id: &str) {
    // DashMap room guard를 잡은 상태에서 await/broadcast_to_room을 호출하면
    // broadcast_to_room이 같은 DashMap shard를 다시 조회하면서 런타임 전체가
    // 멈출 수 있다. 먼저 필요한 상태만 복사하고 guard를 명시적으로 drop한 뒤
    // 네트워크/채널 작업을 수행한다.
    let Some((remaining, updated_users, should_delete)) =
        (if let Some(room) = state.rooms.get(room_id) {
            room.users.write().await.remove(peer_id);
            let updated_users: Vec<String> = room.users.read().await.iter().cloned().collect();
            let remaining = updated_users.len();
            Some((remaining, updated_users, remaining == 0))
        } else {
            None
        })
    else {
        return;
    };

    // 다른 사용자들에게 알림 (room guard 해제 후)
    broadcast_to_room(
        state,
        room_id,
        ServerMessage::UserLeft {
            socket_id: peer_id.to_string(),
        },
    )
    .await;

    if remaining > 0 {
        broadcast_to_room(
            state,
            room_id,
            ServerMessage::RoomUsers {
                users: updated_users,
            },
        )
        .await;
    }

    tracing::info!(
        peer_id = %peer_id,
        room_id = %room_id,
        remaining = remaining,
        "User left room"
    );

    if should_delete {
        state.rooms.remove(room_id);
        tracing::info!(room_id = %room_id, "Room deleted");
    }
}

/// 방 나가기 처리
pub async fn handle_leave_room(state: Arc<AppState>, peer_id: &str) {
    let room_id = if let Some(session) = state.peers.get(peer_id) {
        session.room_id.read().await.clone()
    } else {
        None
    };

    if let Some(room_id) = room_id {
        leave_room_internal(&state, peer_id, &room_id).await;
        if let Some(session) = state.peers.get(peer_id) {
            *session.room_id.write().await = None;
        }
    }
}

/// 방에 메시지 브로드캐스트
async fn broadcast_to_room(state: &AppState, room_id: &str, message: ServerMessage) {
    if let Some(room) = state.rooms.get(room_id) {
        let users = room.users.read().await;
        for peer_id in users.iter() {
            if let Some(session) = state.peers.get(peer_id) {
                let _ = session.sender.send(message.clone());
            }
        }
    }
}

/// 오래된 방 정리
pub async fn cleanup_old_rooms(state: Arc<AppState>) {
    let timeout_ms = state.config.room.timeout_ms;
    let now = Instant::now();
    let mut deleted = 0;

    state.rooms.retain(|room_id, room| {
        let age = now.duration_since(room.created_at).as_millis() as u64;
        if age > timeout_ms {
            tracing::info!(room_id = %room_id, age_ms = age, "Cleaned up old room");
            deleted += 1;
            false
        } else {
            true
        }
    });

    if deleted > 0 {
        tracing::info!(deleted_rooms = deleted, "Cleanup completed");
    }
}
