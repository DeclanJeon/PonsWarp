export const APP_NAME = "PonsWarp";
export const SIGNALING_SERVER_URL = process.env.SIGNALING_SERVER_URL;

// 🚀 청크 사이징 (128KB 브라우저 제한)
export const CHUNK_SIZE_MIN = 16 * 1024;      // 16KB
export const CHUNK_SIZE_INITIAL = 64 * 1024;  // 64KB
export const CHUNK_SIZE_MAX = 128 * 1024;     // 128KB (브라우저 한계)

// WebRTC 버퍼 설정
export const MAX_BUFFERED_AMOUNT = 2 * 1024 * 1024;  // 2MB (증가)
export const LOW_WATER_MARK = 512 * 1024;            // 512KB (증가)
export const HIGH_WATER_MARK = 1.5 * 1024 * 1024;    // 1.5MB

export const HEADER_SIZE = 18; // FileIndex(2) + ChunkIndex(4) + Offset(8) + DataLen(4)
export const CONNECTION_TIMEOUT_MS = 15000;

// 🚀 적응형 배치 설정
export const BATCH_SIZE_MIN = 8;              // 최소 배치
export const BATCH_SIZE_MAX = 64;             // 최대 배치
export const BATCH_SIZE_INITIAL = 16;         // 초기 배치
export const BATCH_REQUEST_SIZE = 16;         // 레거시 호환

// 🚀 프리페치 버퍼 설정
export const PREFETCH_BUFFER_SIZE = 8 * 1024 * 1024;  // 8MB 프리페치 버퍼
export const PREFETCH_LOW_THRESHOLD = 2 * 1024 * 1024; // 2MB 이하면 프리페치 시작
