export const APP_NAME = "PonsWarp";
export const MAX_CHANNELS = 1; // 순서 보장을 위해 단일 채널 사용
export const SIGNALING_SERVER_URL = process.env.SIGNALING_SERVER_URL;

// 🚀 [최적화] 동적 청크 사이징 (네트워크 상태에 따라 변동)
// 🚨 [서버 배포 최적화] 안정성을 위해 64KB 최대값으로 제한
export const CHUNK_SIZE_MIN = 16 * 1024;      // 16KB (느린 네트워크)
export const CHUNK_SIZE_INITIAL = 32 * 1024;  // 32KB (시작)
export const CHUNK_SIZE_MAX = 64 * 1024;      // 64KB (안정적인 최대값)

// 🚨 [보고서 반영] WebRTC 버퍼 한계점 조정 (기존 16MB → 1MB)
// 모바일 기기나 저사양 기기에서 크래시를 유발할 수 있으므로 보수적으로 설정
export const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024;  // 1MB (High Water Mark)
export const LOW_WATER_MARK = 256 * 1024;             // 256KB (Low Water Mark)

// 🚨 [디버깅] 추가 상수
export const DEBUG_ENABLED = true; // 디버그 로깅 활성화 여부
export const CHUNKS_PER_TICK = 4; // 한 틱당 처리할 청크 수
export const FLOW_CONTROL_INTERVAL_MS = 20; // 흐름 제어 체크 간격

// 🚨 [수정] 헤더 크기 증가: FileIndex(2) + ChunkIndex(4) + Offset(8) + DataLen(4) = 18 bytes
export const HEADER_SIZE = 18;

// ACK 타임아웃 (RTT 기반으로 자동 조절되지만, 안전장치)
export const BASE_ACK_TIMEOUT = 5000;

// 🚨 [추가] 연결 타임아웃 상수
export const CONNECTION_TIMEOUT_MS = 15000; // 15초 연결 타임아웃
export const BATCH_REQUEST_SIZE = 16; // 한 번에 요청할 청크 수 (약 1MB)
