//! TURN 자격증명 핸들러

use crate::config::TurnConfig;
use crate::protocol::{IceServer, ServerMessage, TurnConfigData};
use crate::state::AppState;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hmac::{Hmac, Mac};
use sha1::Sha1;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::UnboundedSender;

type HmacSha1 = Hmac<Sha1>;

/// TURN 설정 요청 처리
pub async fn handle_turn_config_request(
    state: Arc<AppState>,
    sender: &UnboundedSender<ServerMessage>,
    room_id: &str,
) {
    let turn_config = &state.config.turn;

    if turn_config.url.is_empty() || turn_config.secret.is_empty() {
        let _ = sender.send(ServerMessage::TurnConfig {
            success: false,
            data: None,
            error: Some("TURN server not configured".to_string()),
        });
        return;
    }

    let credentials = generate_credentials(turn_config);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let _ = sender.send(ServerMessage::TurnConfig {
        success: true,
        data: Some(TurnConfigData {
            ice_servers: credentials,
            ttl: turn_config.credential_ttl,
            timestamp: now,
            room_id: room_id.to_string(),
        }),
        error: None,
    });

    tracing::info!(room_id = %room_id, "TURN config sent");
}

/// TURN 자격증명 생성 (RFC 5766 HMAC-SHA1)
fn generate_credentials(config: &TurnConfig) -> Vec<IceServer> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let expiry_time = now + config.credential_ttl;

    // username 생성
    let random: u64 = rand::random();
    let base_username = format!("user_{}_{:x}", now, random);
    let credential_username = format!("{}:{}", base_username, expiry_time);

    // HMAC-SHA1 해시 생성
    let password = generate_hmac_hash(&credential_username, &config.secret);

    // ICE 서버 목록 생성
    build_ice_servers(config, &credential_username, &password)
}

fn generate_hmac_hash(username: &str, secret: &str) -> String {
    let mut mac =
        HmacSha1::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(username.as_bytes());
    let result = mac.finalize();
    BASE64.encode(result.into_bytes())
}

fn build_ice_servers(config: &TurnConfig, username: &str, password: &str) -> Vec<IceServer> {
    let mut servers = Vec::new();
    let mut turn_urls = Vec::new();
    let turn_host = normalize_turn_host(&config.url);

    if config.enable_udp {
        turn_urls.push(format!("turn:{}:{}", turn_host, config.ports.udp));
    }
    if config.enable_tcp {
        let tcp_url = format!("turn:{}:{}", turn_host, config.ports.tcp);
        if !turn_urls.contains(&tcp_url) {
            turn_urls.push(tcp_url);
        }
    }
    if config.enable_tls {
        let tls_url = format!("turns:{}:{}?transport=tcp", turn_host, config.ports.tls);
        if !turn_urls.contains(&tls_url) {
            turn_urls.push(tls_url);
        }
    }

    // TURN 서버 (인증 필요)
    for url in &turn_urls {
        servers.push(IceServer {
            urls: vec![url.clone()],
            username: Some(username.to_string()),
            credential: Some(password.to_string()),
            credential_type: Some("password".to_string()),
        });
    }

    // 폴백 서버 추가. 값이 이미 stun:/turn:/turns: URL이면 그대로 사용한다.
    // production에는 `stun:stun.l.google.com:19302`가 들어오므로 host:port로 재조합하면
    // `turn:stun:stun.l.google.com:19302:3478` 같은 브라우저가 거부하는 URL이 된다.
    for fallback in &config.fallback_servers {
        let fallback = fallback.trim();
        if fallback.is_empty() {
            continue;
        }
        if fallback.starts_with("stun:") {
            servers.push(IceServer {
                urls: vec![fallback.to_string()],
                username: None,
                credential: None,
                credential_type: None,
            });
        } else if fallback.starts_with("turn:") || fallback.starts_with("turns:") {
            servers.push(IceServer {
                urls: vec![fallback.to_string()],
                username: Some(username.to_string()),
                credential: Some(password.to_string()),
                credential_type: Some("password".to_string()),
            });
        } else {
            let fallback_url = if config.enable_tls {
                format!("turns:{}:{}?transport=tcp", fallback, config.ports.tls)
            } else {
                format!("turn:{}:{}", fallback, config.ports.udp)
            };
            servers.push(IceServer {
                urls: vec![fallback_url],
                username: Some(username.to_string()),
                credential: Some(password.to_string()),
                credential_type: Some("password".to_string()),
            });
        }
    }

    // STUN 서버 (인증 불필요)
    if config.enable_udp {
        servers.push(IceServer {
            urls: vec![format!("stun:{}:{}", turn_host, config.ports.udp)],
            username: None,
            credential: None,
            credential_type: None,
        });
    }

    servers
}

fn normalize_turn_host(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_scheme = trimmed
        .strip_prefix("turns:")
        .or_else(|| trimmed.strip_prefix("turn:"))
        .or_else(|| trimmed.strip_prefix("stun:"))
        .unwrap_or(trimmed);
    let without_query = without_scheme.split('?').next().unwrap_or(without_scheme);
    let without_slashes = without_query.trim_start_matches("//");
    let mut host = without_slashes;

    if host.starts_with('[') {
        if let Some(end) = host.find(']') {
            return host[..=end].to_string();
        }
    }

    if host.matches(':').count() == 1 {
        if let Some((candidate_host, candidate_port)) = host.rsplit_once(':') {
            if candidate_port.parse::<u16>().is_ok() {
                host = candidate_host;
            }
        }
    }

    host.to_string()
}

/// 자격증명 유효성 검증
pub fn validate_credentials(username: &str) -> bool {
    if let Some(expiry_str) = username.split(':').next_back() {
        if let Ok(expiry_time) = expiry_str.parse::<u64>() {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs();
            return expiry_time > now;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{TurnConfig, TurnPorts};

    fn turn_config_with_fallbacks(fallback_servers: Vec<String>) -> TurnConfig {
        TurnConfig {
            url: "ponslink.com".to_string(),
            secret: "test-secret".to_string(),
            realm: "ponslink.com".to_string(),
            enable_tls: false,
            enable_udp: true,
            enable_tcp: true,
            ports: TurnPorts {
                udp: 3478,
                tcp: 3478,
                tls: 443,
            },
            credential_ttl: 600,
            fallback_servers,
        }
    }

    #[test]
    fn fallback_stun_url_is_returned_as_stun_server_without_turn_credentials() {
        let config = turn_config_with_fallbacks(vec!["stun:stun.l.google.com:19302".to_string()]);

        let servers = build_ice_servers(&config, "user:123", "password");

        assert!(
            servers.iter().any(|server| {
                server.urls == vec!["stun:stun.l.google.com:19302".to_string()]
                    && server.username.is_none()
                    && server.credential.is_none()
            }),
            "expected raw STUN fallback URL without credentials, got {servers:?}"
        );
        assert!(
            servers
                .iter()
                .flat_map(|server| server.urls.iter())
                .all(|url| !url.starts_with("turn:stun:")),
            "fallback STUN URL must not be rewritten into invalid TURN URL: {servers:?}"
        );
    }

    #[test]
    fn turn_server_url_with_scheme_and_port_is_normalized_before_composing_ice_urls() {
        let mut config =
            turn_config_with_fallbacks(vec!["stun:stun.l.google.com:19302".to_string()]);
        config.url = "turn:localhost:3478".to_string();

        let servers = build_ice_servers(&config, "user:123", "password");
        let urls: Vec<String> = servers
            .iter()
            .flat_map(|server| server.urls.iter().cloned())
            .collect();

        assert!(urls.contains(&"turn:localhost:3478".to_string()));
        assert!(urls.contains(&"stun:localhost:3478".to_string()));
        assert!(
            urls.iter()
                .all(|url| !url.contains("turn:turn:") && !url.ends_with(":3478:3478")),
            "ICE URLs must be browser-parseable, got {urls:?}"
        );
    }
}
