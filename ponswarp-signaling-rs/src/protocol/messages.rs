//! 클라이언트-서버 메시지 프로토콜 정의

use serde::{Deserialize, Serialize};

/// 클라이언트 → 서버 메시지
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ClientMessage {
    // Connection
    Heartbeat,

    // Room Management
    JoinRoom {
        room_id: String,
    },
    LeaveRoom,

    // WebRTC Signaling
    Offer {
        room_id: String,
        sdp: String,
        target: Option<String>,
    },
    Answer {
        room_id: String,
        sdp: String,
        target: Option<String>,
    },
    IceCandidate {
        room_id: String,
        candidate: String,
        target: Option<String>,
    },

    // File Transfer Manifest (Native QUIC mode)
    Manifest {
        room_id: String,
        manifest: String, // JSON stringified manifest
        target: Option<String>,
    },

    // 🆕 Transfer Ready (Receiver -> Sender)
    TransferReady {
        room_id: String,
        target: Option<String>,
    },

    // 🆕 Transfer Complete (Receiver -> Sender)
    TransferComplete {
        room_id: String,
        target: Option<String>,
    },

    // TURN
    RequestTurnConfig {
        room_id: String,
        force_refresh: Option<bool>,
    },
    RefreshTurnCredentials {
        room_id: String,
        current_username: String,
    },
    CheckTurnServerStatus,
}

/// 서버 → 클라이언트 메시지
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ServerMessage {
    // Connection
    Connected {
        socket_id: String,
    },
    HeartbeatAck,
    Error {
        code: String,
        message: String,
    },

    // Room Events
    JoinedRoom {
        room_id: String,
        socket_id: String,
        user_count: usize,
    },
    RoomUsers {
        users: Vec<String>,
    },
    PeerJoined {
        socket_id: String,
        room_id: String,
    },
    UserLeft {
        socket_id: String,
    },
    RoomFull {
        room_id: String,
    },

    // WebRTC Signaling
    Offer {
        from: String,
        sdp: String,
    },
    Answer {
        from: String,
        sdp: String,
    },
    IceCandidate {
        from: String,
        candidate: String,
    },

    // File Transfer Manifest (Native QUIC mode)
    Manifest {
        from: String,
        manifest: String,
    },

    // 🆕 Transfer Ready (Receiver -> Sender)
    TransferReady {
        from: String,
    },

    // 🆕 Transfer Complete (Receiver -> Sender)
    TransferComplete {
        from: String,
    },

    // TURN
    TurnConfig {
        success: bool,
        data: Option<TurnConfigData>,
        error: Option<String>,
    },
    TurnServerStatusUpdate {
        room_id: String,
        timestamp: u64,
    },
}

/// TURN 설정 데이터
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnConfigData {
    pub ice_servers: Vec<IceServer>,
    pub ttl: u64,
    pub timestamp: u64,
    pub room_id: String,
}

/// ICE 서버 설정
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_type: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_manifest_round_trips_with_target() {
        let message = ClientMessage::Manifest {
            room_id: "room-123".to_string(),
            manifest: r#"{"files":[{"name":"demo.bin","size":1024}]}"#.to_string(),
            target: Some("peer-456".to_string()),
        };

        let value = serde_json::to_value(&message).expect("serialize manifest");
        assert_eq!(value["type"], "Manifest");
        assert_eq!(value["payload"]["room_id"], "room-123");
        assert_eq!(value["payload"]["target"], "peer-456");

        let decoded: ClientMessage = serde_json::from_value(value).expect("deserialize manifest");
        match decoded {
            ClientMessage::Manifest {
                room_id,
                manifest,
                target,
            } => {
                assert_eq!(room_id, "room-123");
                assert!(manifest.contains("demo.bin"));
                assert_eq!(target.as_deref(), Some("peer-456"));
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn server_turn_config_omits_absent_credentials() {
        let message = ServerMessage::TurnConfig {
            success: true,
            data: Some(TurnConfigData {
                ice_servers: vec![IceServer {
                    urls: vec!["stun:stun.example.com:3478".to_string()],
                    username: None,
                    credential: None,
                    credential_type: None,
                }],
                ttl: 600,
                timestamp: 1_700_000_000,
                room_id: "room-123".to_string(),
            }),
            error: None,
        };

        let value = serde_json::to_value(&message).expect("serialize turn config");
        let ice_server = &value["payload"]["data"]["ice_servers"][0];

        assert_eq!(value["type"], "TurnConfig");
        assert_eq!(ice_server["urls"][0], "stun:stun.example.com:3478");
        assert!(ice_server.get("username").is_none());
        assert!(ice_server.get("credential").is_none());
        assert!(ice_server.get("credential_type").is_none());
    }
}
