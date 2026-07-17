use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeshCleanupReport {
    pub expired_or_revoked_shares_removed: usize,
    pub stale_presence_removed: usize,
    pub old_events_removed: usize,
    pub expired_availability_removed: usize,
}

#[derive(Debug, Clone)]
pub struct MeshCandidate {
    pub availability: MeshAvailability,
    pub online: bool,
    pub endpoint_hints: Value,
}

impl std::ops::Add for MeshCleanupReport {
    type Output = Self;

    fn add(self, rhs: Self) -> Self::Output {
        Self {
            expired_or_revoked_shares_removed: self.expired_or_revoked_shares_removed
                + rhs.expired_or_revoked_shares_removed,
            stale_presence_removed: self.stale_presence_removed + rhs.stale_presence_removed,
            old_events_removed: self.old_events_removed + rhs.old_events_removed,
            expired_availability_removed: self.expired_availability_removed
                + rhs.expired_availability_removed,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshWorkspace {
    pub workspace_id: String,
    pub name: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshNode {
    pub workspace_id: String,
    pub node_id: String,
    pub display_name: String,
    pub public_key: String,
    pub status: String,
    #[serde(default)]
    pub capabilities: Value,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshPresence {
    pub workspace_id: String,
    pub node_id: String,
    pub online: bool,
    #[serde(default)]
    pub endpoint_hints: Value,
    #[serde(default)]
    pub load: Value,
    pub updated_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshFile {
    pub workspace_id: String,
    pub file_id: String,
    pub name: String,
    pub size_bytes: u64,
    pub piece_size: u64,
    pub piece_count: u64,
    #[serde(default)]
    pub manifest: Value,
    #[serde(default)]
    pub tags: Value,
    pub created_by_node_id: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshAvailability {
    pub workspace_id: String,
    pub file_id: String,
    pub node_id: String,
    pub complete: bool,
    #[serde(default)]
    pub verified_ranges: Value,
    pub updated_at: u64,
    pub advertise_until: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshEvent {
    pub event_id: String,
    pub workspace_id: String,
    pub event_type: String,
    #[serde(default)]
    pub payload: Value,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshShare {
    pub code: String,
    pub workspace_id: String,
    pub file_id: String,
    pub created_by_node_id: String,
    pub expires_at: u64,
    pub revoked_at: Option<u64>,
    #[serde(default)]
    pub capabilities: Value,
    pub created_at: u64,
}
