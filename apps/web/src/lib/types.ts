export type ConnectionState =
  | "waiting"
  | "signaling"
  | "connecting"
  | "connected"
  | "transferring"
  | "paused"
  | "reconnecting"
  | "completed"
  | "failed";

export type TransferViewState =
  | "idle"
  | "files-selected"
  | "creating-session"
  | "waiting-receiver"
  | "receiver-joined"
  | "negotiating"
  | "ready"
  | "transferring"
  | "paused"
  | "reconnecting"
  | "verifying"
  | "completed"
  | "failed"
  | "expired";

export type FileTransferState =
  | "queued"
  | "preparing"
  | "transferring"
  | "verifying"
  | "completed"
  | "failed"
  | "skipped";

export type Role = "sender" | "receiver";

export type MotionIntensity = "full" | "reduced" | "off";

export type TransferProgress = {
  totalBytes: number;
  transferredBytes: number;
  progress: number;
  currentSpeedBps: number;
  averageSpeedBps: number;
  etaSeconds: number | null;
  currentFileIndex: number;
  currentFileTransferredBytes: number;
  currentFileTotalBytes: number;
  connectionState: ConnectionState;
};

export type TransferFileMeta = {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified?: number;
};

export type TransferFileItem = TransferFileMeta & {
  state: FileTransferState;
  transferredBytes: number;
  progress: number;
  error?: string;
};

export type SessionInfo = {
  sessionId: string;
  code: string;
  role: Role;
  createdAt: number;
  expiresAt: number;
  shareUrl: string;
};

export type PeerConnectionMode = "direct" | "relay" | "unknown";

export type SignalingMessage =
  | { type: "create-session"; role: "sender"; files?: TransferFileMeta[] }
  | { type: "join-session"; code: string; role: "receiver" }
  | { type: "session-created"; sessionId: string; code: string; expiresAt: number }
  | { type: "session-joined"; sessionId: string; code: string; files: TransferFileMeta[]; expiresAt: number }
  | { type: "peer-joined"; role: Role }
  | { type: "peer-left"; role: Role }
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit | null }
  | { type: "files-updated"; files: TransferFileMeta[] }
  | { type: "reject" }
  | { type: "error"; code: string; message: string }
  | { type: "ping" }
  | { type: "pong" };

export type ControlMessage =
  | { kind: "hello"; role: Role; files?: TransferFileMeta[] }
  | { kind: "accept"; saveMode: "fs-access" | "streamsaver" | "blob" }
  | { kind: "reject" }
  | { kind: "start-transfer" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "file-start"; fileId: string; index: number; name: string; size: number; type: string; totalChunks: number }
  | { kind: "file-complete"; fileId: string; checksum: string }
  | { kind: "file-ack"; fileId: string; checksum: string; ok: boolean }
  | { kind: "transfer-complete" }
  | { kind: "error"; message: string; code?: string }
  | { kind: "progress"; transferredBytes: number; totalBytes: number; fileId: string; fileTransferred: number };

export type WarpMotionParams = {
  portalIntensity: number;
  particleSpeed: number;
  particleDensity: number;
  unstable: boolean;
  mode: "blackhole" | "whitehole" | "idle";
};

export const EMPTY_PROGRESS: TransferProgress = {
  totalBytes: 0,
  transferredBytes: 0,
  progress: 0,
  currentSpeedBps: 0,
  averageSpeedBps: 0,
  etaSeconds: null,
  currentFileIndex: 0,
  currentFileTransferredBytes: 0,
  currentFileTotalBytes: 0,
  connectionState: "waiting",
};
