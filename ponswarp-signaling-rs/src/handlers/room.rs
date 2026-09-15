//! 방 관리 핸들러

use crate::protocol::ServerMessage;
use crate::state::{AppState, Room};
use dashmap::mapref::entry::Entry;
use std::sync::Arc;

/// 방 참여 처리
/// `create`가 true이면 방이 없을 때 새로 만든다(sender).
/// false(참여 전용, receiver)인데 방이 없으면 빈 방을 만들지 않고
/// RoomNotFound를 즉시 반환해 45초 타임아웃 대기를 방지한다.
pub async fn handle_join_room(state: Arc<AppState>, peer_id: &str, room_id: &str, create: bool) {
    let room_id = room_id.trim().to_string();
    let max_size = state.config.room.max_size;

    tracing::info!(peer_id = %peer_id, room_id = %room_id, "handle_join_room started");

    // 방 가져오기 또는 생성 및 로직 처리 (스코프 제한으로 Deadlock 방지)
    let updated_users = {
        tracing::info!(room_id = %room_id, "Acquiring room lock...");
        let room = match state.rooms.entry(room_id.clone()) {
            Entry::Occupied(entry) => entry.into_ref(),
            Entry::Vacant(entry) => {
                if !create {
                    // 참여 전용 JoinRoom인데 방이 없음 → 잘못된 방 코드.
                    // 빈 방을 생성하지 않고 즉시 실패를 알린다.
                    if let Some(session) = state.peers.get(peer_id) {
                        let _ = session.sender.send(ServerMessage::RoomNotFound {
                            room_id: room_id.clone(),
                        });
                    }
                    tracing::info!(peer_id = %peer_id, room_id = %room_id, "Join rejected: room not found");
                    return;
                }
                tracing::info!(room_id = %room_id, "Room created");
                entry.insert(Room::new(room_id.clone()))
            }
        };
        room.touch();
        tracing::info!(room_id = %room_id, "Room lock acquired");

        // 방은 존재하지만 비어있음(마지막 멤버 퇴장 직후 등) → 참여 전용이면 not found
        if !create && room.users.read().await.is_empty() {
            if let Some(session) = state.peers.get(peer_id) {
                let _ = session.sender.send(ServerMessage::RoomNotFound {
                    room_id: room_id.clone(),
                });
            }
            tracing::info!(peer_id = %peer_id, room_id = %room_id, "Join rejected: room empty");
            return;
        }

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

        // Same peer already in this room (duplicate JoinRoom from client).
        // Do not re-broadcast PeerJoined — that races sender-side addPeer.
        let already_member = existing_users.iter().any(|id| id == peer_id);
        if already_member {
            let user_count = existing_users.len();
            if let Some(session) = state.peers.get(peer_id) {
                *session.room_id.write().await = Some(room_id.clone());
                let _ = session.sender.send(ServerMessage::RoomUsers {
                    users: existing_users
                        .iter()
                        .filter(|id| id.as_str() != peer_id)
                        .cloned()
                        .collect(),
                });
                let _ = session.sender.send(ServerMessage::JoinedRoom {
                    room_id: room_id.clone(),
                    socket_id: peer_id.to_string(),
                    user_count,
                });
                tracing::info!(
                    peer_id = %peer_id,
                    room_id = %room_id,
                    "Duplicate JoinRoom ignored (already a member)"
                );
            }
            return;
        }

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
            room.touch();
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
        room.touch();
        let users = room.users.read().await;
        for peer_id in users.iter() {
            if let Some(session) = state.peers.get(peer_id) {
                let _ = session.sender.send(message.clone());
            }
        }
    }
}

/// 방 활동 시각 갱신 (시그널링 메시지 릴레이 시 호출)
pub fn touch_room(state: &AppState, room_id: &str) {
    if let Some(room) = state.rooms.get(room_id) {
        room.touch();
    }
}

/// 오래된 방 정리
/// TTL은 생성 시각이 아니라 마지막 활동(last_activity) 기준으로 측정한다.
/// 단, 세션이 살아있는 멤버가 있는 방은 유휴 시간과 무관하게 유지한다 —
/// 전송 중에는 시그널링 메시지가 오가지 않을 수 있으므로, 연결된 멤버가 있는
/// 방을 정리하면 1시간 이상 걸리는 전송이 시그널링 방을 잃는다.
pub async fn cleanup_old_rooms(state: Arc<AppState>) {
    let timeout_ms = state.config.room.timeout_ms;
    let mut deleted = 0;

    state.rooms.retain(|room_id, room| {
        let idle_ms = room.idle_duration().as_millis() as u64;
        // 살아있는 피어 세션이 하나라도 있으면 방은 활성 상태로 간주한다.
        // users 락을 잡을 수 없으면(쓰기 진행 중) 보수적으로 유지한다.
        let has_live_member = room
            .users
            .try_read()
            .map(|users| users.iter().any(|id| state.peers.contains_key(id)))
            .unwrap_or(true);
        if !has_live_member && idle_ms > timeout_ms {
            tracing::info!(room_id = %room_id, idle_ms = idle_ms, "Cleaned up idle room");
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
