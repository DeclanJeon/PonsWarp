use anyhow::{bail, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashSet;

use crate::mesh::{MeshFile, MeshShare};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    Anonymous {
        ip_hash: String,
    },
    User {
        user_id: String,
        session_id: String,
    },
    Node {
        workspace_id: String,
        node_id: String,
        token_id: String,
    },
    Admin {
        user_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceRole {
    Owner,
    Admin,
    Writer,
    Reader,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceAction {
    ManageWorkspace,
    ManageMembers,
    RegisterNode,
    PublishFile,
    CreateShare,
    ReadMetadata,
}

pub fn actor_workspace_id(actor: &Actor) -> Option<&str> {
    match actor {
        Actor::Node { workspace_id, .. } => Some(workspace_id.as_str()),
        _ => None,
    }
}

pub fn can_workspace(
    actor: &Actor,
    workspace_id: &str,
    role: Option<WorkspaceRole>,
    action: WorkspaceAction,
) -> bool {
    if matches!(actor, Actor::Admin { .. }) {
        return true;
    }

    if let Actor::Node {
        workspace_id: node_workspace_id,
        ..
    } = actor
    {
        return node_workspace_id == workspace_id
            && matches!(
                action,
                WorkspaceAction::PublishFile
                    | WorkspaceAction::CreateShare
                    | WorkspaceAction::ReadMetadata
            );
    }

    if !matches!(actor, Actor::User { .. }) {
        return false;
    }

    matches!(
        (role, action),
        (Some(WorkspaceRole::Owner), _)
            | (
                Some(WorkspaceRole::Admin),
                WorkspaceAction::ManageWorkspace
                    | WorkspaceAction::ManageMembers
                    | WorkspaceAction::RegisterNode
                    | WorkspaceAction::PublishFile
                    | WorkspaceAction::CreateShare
                    | WorkspaceAction::ReadMetadata
            )
            | (
                Some(WorkspaceRole::Writer),
                WorkspaceAction::RegisterNode
                    | WorkspaceAction::PublishFile
                    | WorkspaceAction::CreateShare
                    | WorkspaceAction::ReadMetadata
            )
            | (Some(WorkspaceRole::Reader), WorkspaceAction::ReadMetadata)
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretHash {
    pub id: String,
    pub hash: String,
}

pub fn generate_bearer_token(prefix: &str) -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub fn deterministic_test_token(prefix: &str, seed: &str) -> String {
    let digest = hmac_sha256_bytes(b"ponswarp-deterministic-test-token", seed.as_bytes());
    format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(digest))
}

pub fn hash_secret(secret: &str, pepper: &str, context: &str) -> Result<SecretHash> {
    ensure_pepper(pepper)?;
    let id_bytes = hmac_sha256_bytes(
        pepper.as_bytes(),
        format!("id:{context}:{secret}").as_bytes(),
    );
    let hash_bytes = hmac_sha256_bytes(
        pepper.as_bytes(),
        format!("hash:{context}:{secret}").as_bytes(),
    );
    Ok(SecretHash {
        id: URL_SAFE_NO_PAD.encode(&id_bytes[..16]),
        hash: URL_SAFE_NO_PAD.encode(hash_bytes),
    })
}

pub fn verify_secret(secret: &str, pepper: &str, context: &str, expected: &SecretHash) -> bool {
    let Ok(candidate) = hash_secret(secret, pepper, context) else {
        return false;
    };
    constant_time_eq(candidate.id.as_bytes(), expected.id.as_bytes())
        && constant_time_eq(candidate.hash.as_bytes(), expected.hash.as_bytes())
}

pub fn issue_node_token(
    workspace_id: &str,
    node_id: &str,
    pepper: &str,
) -> Result<(String, SecretHash)> {
    let token = generate_bearer_token("pwnode");
    let hash = hash_secret(&token, pepper, &node_token_context(workspace_id, node_id))?;
    Ok((token, hash))
}

pub fn verify_node_token(
    token: &str,
    workspace_id: &str,
    node_id: &str,
    pepper: &str,
    expected: &SecretHash,
) -> bool {
    verify_secret(
        token,
        pepper,
        &node_token_context(workspace_id, node_id),
        expected,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnrollmentToken {
    pub workspace_id: String,
    pub issued_by_user_id: String,
    pub token_hash: SecretHash,
    pub expires_at: u64,
    pub consumed_at: Option<u64>,
}

pub fn issue_enrollment_token(
    workspace_id: &str,
    issued_by_user_id: &str,
    now: u64,
    ttl_seconds: u64,
    pepper: &str,
) -> Result<(String, EnrollmentToken)> {
    let token = generate_bearer_token("pwenroll");
    let token_hash = hash_secret(&token, pepper, &enrollment_context(workspace_id))?;
    Ok((
        token,
        EnrollmentToken {
            workspace_id: workspace_id.to_string(),
            issued_by_user_id: issued_by_user_id.to_string(),
            token_hash,
            expires_at: now + ttl_seconds.max(1),
            consumed_at: None,
        },
    ))
}

pub fn consume_enrollment_token(
    record: &mut EnrollmentToken,
    presented: &str,
    now: u64,
    pepper: &str,
) -> Result<()> {
    if record.consumed_at.is_some() || record.expires_at <= now {
        bail!("enrollment token is inactive");
    }
    if !verify_secret(
        presented,
        pepper,
        &enrollment_context(&record.workspace_id),
        &record.token_hash,
    ) {
        bail!("enrollment token is invalid");
    }
    record.consumed_at = Some(now);
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicShareSummary {
    #[serde(rename = "fileId")]
    pub file_id: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "pieceSize")]
    pub piece_size: u64,
    #[serde(rename = "pieceCount")]
    pub piece_count: u64,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

pub fn minimize_public_share_response(share: &MeshShare, file: &MeshFile) -> PublicShareSummary {
    let expose_name = share
        .capabilities
        .get("exposeFileName")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    PublicShareSummary {
        file_id: share.file_id.clone(),
        size_bytes: file.size_bytes,
        piece_size: file.piece_size,
        piece_count: file.piece_count,
        expires_at: share.expires_at,
        name: expose_name.then(|| file.name.clone()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectGrantClaims {
    #[serde(rename = "shareHash")]
    pub share_hash: String,
    #[serde(rename = "fileId")]
    pub file_id: String,
    #[serde(rename = "sourceNodeId")]
    pub source_node_id: String,
    #[serde(rename = "receiverFingerprint")]
    pub receiver_fingerprint: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
    pub nonce: String,
}

pub fn issue_connect_grant(
    share_code: &str,
    file_id: &str,
    source_node_id: &str,
    receiver_fingerprint: &str,
    now: u64,
    ttl_seconds: u64,
    pepper: &str,
) -> Result<(String, ConnectGrantClaims)> {
    ensure_pepper(pepper)?;
    let ttl = ttl_seconds.clamp(30, 120);
    let nonce = generate_bearer_token("cgnonce");
    let share_hash = hash_secret(share_code, pepper, "share-code")?.id;
    let claims = ConnectGrantClaims {
        share_hash,
        file_id: file_id.to_string(),
        source_node_id: source_node_id.to_string(),
        receiver_fingerprint: receiver_fingerprint.to_string(),
        expires_at: now + ttl,
        nonce,
    };
    let payload = serde_json::to_vec(&claims)?;
    let sig = hmac_sha256_bytes(pepper.as_bytes(), &payload);
    Ok((
        format!(
            "pwgrant_{}.{}",
            URL_SAFE_NO_PAD.encode(payload),
            URL_SAFE_NO_PAD.encode(sig)
        ),
        claims,
    ))
}

#[derive(Debug, Clone, Copy)]
pub struct ConnectGrantVerification<'a> {
    pub share_code: &'a str,
    pub file_id: &'a str,
    pub source_node_id: &'a str,
    pub receiver_fingerprint: &'a str,
    pub now: u64,
    pub pepper: &'a str,
}

pub fn verify_connect_grant(
    grant: &str,
    expected: ConnectGrantVerification<'_>,
    consumed_nonces: &mut HashSet<String>,
) -> Result<ConnectGrantClaims> {
    ensure_pepper(expected.pepper)?;
    let raw = grant
        .strip_prefix("pwgrant_")
        .ok_or_else(|| anyhow::anyhow!("invalid connect grant"))?;
    let (payload_b64, sig_b64) = raw
        .split_once('.')
        .ok_or_else(|| anyhow::anyhow!("invalid connect grant"))?;
    let payload = URL_SAFE_NO_PAD.decode(payload_b64)?;
    let sig = URL_SAFE_NO_PAD.decode(sig_b64)?;
    let expected_sig = hmac_sha256_bytes(expected.pepper.as_bytes(), &payload);
    if !constant_time_eq(&sig, &expected_sig) {
        bail!("invalid connect grant signature");
    }
    let claims: ConnectGrantClaims = serde_json::from_slice(&payload)?;
    if claims.expires_at <= expected.now {
        bail!("connect grant expired");
    }
    if claims.share_hash != hash_secret(expected.share_code, expected.pepper, "share-code")?.id
        || claims.file_id != expected.file_id
        || claims.source_node_id != expected.source_node_id
        || claims.receiver_fingerprint != expected.receiver_fingerprint
    {
        bail!("connect grant binding mismatch");
    }
    if !consumed_nonces.insert(claims.nonce.clone()) {
        bail!("connect grant replayed");
    }
    Ok(claims)
}

pub fn public_error_body() -> Value {
    json!({ "error": "share_not_found_or_inactive" })
}

pub(crate) fn node_token_context(workspace_id: &str, node_id: &str) -> String {
    format!("node-token:{workspace_id}:{node_id}")
}

fn enrollment_context(workspace_id: &str) -> String {
    format!("node-enrollment:{workspace_id}")
}

fn ensure_pepper(pepper: &str) -> Result<()> {
    if pepper.trim().len() < 32 {
        bail!("mesh token pepper must be at least 32 characters");
    }
    Ok(())
}

fn hmac_sha256_bytes(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key size");
    mac.update(message);
    mac.finalize().into_bytes().to_vec()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEPPER: &str = "0123456789abcdef0123456789abcdef";

    fn file() -> MeshFile {
        MeshFile {
            workspace_id: "ws".into(),
            file_id: "file".into(),
            name: "secret-name.bin".into(),
            size_bytes: 42,
            piece_size: 4,
            piece_count: 11,
            manifest: json!({ "doNotLeak": true }),
            tags: json!(["private"]),
            created_by_node_id: "node".into(),
            created_at: 1,
        }
    }

    fn share(capabilities: Value) -> MeshShare {
        MeshShare {
            code: "ABCD-1234".into(),
            workspace_id: "ws".into(),
            file_id: "file".into(),
            created_by_node_id: "node".into(),
            expires_at: 100,
            revoked_at: None,
            capabilities,
            created_at: 1,
        }
    }

    #[test]
    fn token_hash_verification_uses_hmac_not_raw_token_equality() {
        let token = deterministic_test_token("pwnode", "node-a");
        let hash = hash_secret(&token, PEPPER, "node-token:ws:node").expect("hash");
        assert_ne!(hash.hash, token);
        assert_ne!(hash.id, token);
        assert!(verify_secret(&token, PEPPER, "node-token:ws:node", &hash));
        assert!(!verify_secret("wrong", PEPPER, "node-token:ws:node", &hash));
        assert!(!verify_secret(&token, PEPPER, "node-token:ws:other", &hash));
    }

    #[test]
    fn node_token_generation_hash_and_verification_are_bound_to_node() {
        let (token, hash) = issue_node_token("ws", "node", PEPPER).expect("issued");
        assert!(token.starts_with("pwnode_"));
        assert!(verify_node_token(&token, "ws", "node", PEPPER, &hash));
        assert!(!verify_node_token(&token, "ws", "other", PEPPER, &hash));
    }

    #[test]
    fn one_time_enrollment_consumes_once_and_fails_closed() {
        let (token, mut record) =
            issue_enrollment_token("ws", "user", 10, 60, PEPPER).expect("enrollment");
        let mut expired = record.clone();
        expired.expires_at = 1;
        consume_enrollment_token(&mut expired, &token, 10, PEPPER).expect_err("expired");
        consume_enrollment_token(&mut record, &token, 20, PEPPER).expect("first use");
        consume_enrollment_token(&mut record, &token, 21, PEPPER).expect_err("replay denied");
    }

    #[test]
    fn workspace_rbac_decisions_are_fail_closed() {
        let anon = Actor::Anonymous {
            ip_hash: "ip".into(),
        };
        let user = Actor::User {
            user_id: "u".into(),
            session_id: "s".into(),
        };
        let node = Actor::Node {
            workspace_id: "ws".into(),
            node_id: "n".into(),
            token_id: "t".into(),
        };
        assert!(!can_workspace(
            &anon,
            "ws",
            Some(WorkspaceRole::Owner),
            WorkspaceAction::ReadMetadata
        ));
        assert!(!can_workspace(
            &user,
            "ws",
            None,
            WorkspaceAction::ReadMetadata
        ));
        assert!(can_workspace(
            &user,
            "ws",
            Some(WorkspaceRole::Reader),
            WorkspaceAction::ReadMetadata
        ));
        assert!(!can_workspace(
            &user,
            "ws",
            Some(WorkspaceRole::Reader),
            WorkspaceAction::CreateShare
        ));
        assert!(can_workspace(
            &node,
            "ws",
            None,
            WorkspaceAction::PublishFile
        ));
        assert!(!can_workspace(
            &node,
            "other",
            None,
            WorkspaceAction::PublishFile
        ));
        assert!(!can_workspace(
            &node,
            "ws",
            None,
            WorkspaceAction::ManageMembers
        ));
    }

    #[test]
    fn public_share_summary_minimizes_response_by_default() {
        let summary = minimize_public_share_response(&share(json!({})), &file());
        let value = serde_json::to_value(summary).expect("json");
        assert_eq!(value.get("fileId"), Some(&json!("file")));
        assert!(value.get("name").is_none());
        assert!(value.get("workspaceId").is_none());
        assert!(value.get("manifest").is_none());
        assert!(value.get("createdByNodeId").is_none());

        let named =
            minimize_public_share_response(&share(json!({ "exposeFileName": true })), &file());
        assert_eq!(named.name.as_deref(), Some("secret-name.bin"));
    }

    #[test]
    fn connect_grant_is_short_lived_bound_and_replay_limited() {
        let mut consumed = HashSet::new();
        let (grant, claims) =
            issue_connect_grant("ABCD-1234", "file", "source", "receiver", 100, 90, PEPPER)
                .expect("grant");
        assert_eq!(claims.expires_at, 190);
        let valid = ConnectGrantVerification {
            share_code: "ABCD-1234",
            file_id: "file",
            source_node_id: "source",
            receiver_fingerprint: "receiver",
            now: 120,
            pepper: PEPPER,
        };
        assert!(verify_connect_grant(&grant, valid, &mut consumed).is_ok());
        assert!(verify_connect_grant(
            &grant,
            ConnectGrantVerification { now: 121, ..valid },
            &mut consumed
        )
        .is_err());

        let (other, _) =
            issue_connect_grant("ABCD-1234", "file", "source", "receiver", 100, 90, PEPPER)
                .expect("grant");
        assert!(verify_connect_grant(
            &other,
            ConnectGrantVerification {
                share_code: "WRONG-1234",
                ..valid
            },
            &mut HashSet::new()
        )
        .is_err());
        assert!(verify_connect_grant(
            &other,
            ConnectGrantVerification {
                file_id: "other",
                ..valid
            },
            &mut HashSet::new()
        )
        .is_err());
        assert!(verify_connect_grant(
            &other,
            ConnectGrantVerification {
                receiver_fingerprint: "other",
                ..valid
            },
            &mut HashSet::new()
        )
        .is_err());
        assert!(verify_connect_grant(
            &other,
            ConnectGrantVerification { now: 191, ..valid },
            &mut HashSet::new()
        )
        .is_err());
    }
}
