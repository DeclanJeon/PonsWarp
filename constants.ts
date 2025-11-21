export const APP_NAME = "PonsWarp";
export const MAX_CHANNELS = 1; // 순서 보장을 위해 단일 채널 사용
export const SIGNALING_SERVER_URL = process.env.SIGNALING_SERVER_URL;

// 🚀 [최적화] 동적 청크 사이징 (네트워크 상태에 따라 변동)
export const CHUNK_SIZE_MIN = 16 * 1024;      // 16KB (느린 네트워크)
export const CHUNK_SIZE_INITIAL = 64 * 1024;  // 64KB (시작)
export const CHUNK_SIZE_MAX = 256 * 1024;     // 256KB (고속 네트워크)

// 🚀 [최적화] WebRTC 버퍼 한계점 상향 (16MB)
// 브라우저 메모리가 허용하는 한 넉넉하게 잡아 전송이 멈추지 않게 함
export const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024;
export const LOW_WATER_MARK = 4 * 1024 * 1024; 

// 🚨 [수정] 헤더 크기 증가: FileIndex(2) + ChunkIndex(4) + Offset(8) + DataLen(4) = 18 bytes
export const HEADER_SIZE = 18;

// ACK 타임아웃 (RTT 기반으로 자동 조절되지만, 안전장치)
export const BASE_ACK_TIMEOUT = 5000; 
