export const APP_NAME = "PonsWarp";
export const SIGNALING_SERVER_URL = process.env.SIGNALING_SERVER_URL;

// 🚀 동적 청크 사이징
export const CHUNK_SIZE_MIN = 16 * 1024;      // 16KB
export const CHUNK_SIZE_INITIAL = 32 * 1024;  // 32KB
export const CHUNK_SIZE_MAX = 64 * 1024;      // 64KB

// WebRTC 버퍼 설정
export const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024;  // 1MB
export const LOW_WATER_MARK = 256 * 1024;            // 256KB

export const HEADER_SIZE = 18; // FileIndex(2) + ChunkIndex(4) + Offset(8) + DataLen(4)
export const CONNECTION_TIMEOUT_MS = 15000;
export const BATCH_REQUEST_SIZE = 16;
