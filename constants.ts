export const APP_NAME = "PonsWarp";
export const SIGNALING_SERVER_URL = process.env.SIGNALING_SERVER_URL;

// 🚀 청크 사이징 (128KB 브라우저 제한)
export const CHUNK_SIZE_MIN = 16 * 1024;      // 16KB
export const CHUNK_SIZE_INITIAL = 64 * 1024;  // 64KB
export const CHUNK_SIZE_MAX = 128 * 1024;     // 128KB (브라우저 한계)

// 🚀 [성능 최적화] WebRTC 버퍼 설정 - 파이프라인 용량 증대
// 16MB는 브라우저가 안정적으로 처리 가능하며, 100MB/s 이상 속도 지원
export const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024;  // 16MB (안전선)
export const LOW_WATER_MARK = 4 * 1024 * 1024;        // 4MB (리필 시작)
export const HIGH_WATER_MARK = 12 * 1024 * 1024;      // 12MB (리필 중단)

export const HEADER_SIZE = 18; // FileIndex(2) + ChunkIndex(4) + Offset(8) + DataLen(4)
export const CONNECTION_TIMEOUT_MS = 15000;

// 🚀 [성능 최적화] 적응형 배치 설정 - 파이프라인 최적화
export const BATCH_SIZE_MIN = 16;             // 최소 배치 (8 -> 16)
export const BATCH_SIZE_MAX = 64;             // 최대 배치 (128 -> 64, 메모리 스파이크 방지)
export const BATCH_SIZE_INITIAL = 32;         // 초기 배치
export const BATCH_REQUEST_SIZE = 32;         // 레거시 호환

// 🚀 프리페치 버퍼 설정 - [Phase 3] 더 큰 버퍼
export const PREFETCH_BUFFER_SIZE = 16 * 1024 * 1024;  // 16MB 프리페치 버퍼 (증가)
export const PREFETCH_LOW_THRESHOLD = 4 * 1024 * 1024; // 4MB 이하면 프리페치 시작

// 🚀 [Phase 3] 멀티 채널 설정
export const MULTI_CHANNEL_COUNT = 3;                  // 기본 데이터 채널 수
export const MULTI_CHANNEL_MIN = 1;                    // 최소 채널 수
export const MULTI_CHANNEL_MAX = 4;                    // 최대 채널 수
export const CHANNEL_BUFFER_THRESHOLD = 512 * 1024;    // 채널별 버퍼 임계값

// 🚀 [Phase 3] 네트워크 적응형 제어 설정
export const BBR_STARTUP_GAIN = 2.89;                  // BBR Startup 모드 gain
export const BBR_DRAIN_GAIN = 0.75;                    // BBR Drain 모드 gain
export const BBR_PROBE_RTT_DURATION = 200;             // ProbeRTT 지속 시간 (ms)
export const RTT_SAMPLE_WINDOW = 10;                   // RTT 샘플 윈도우 크기
export const BANDWIDTH_SAMPLE_WINDOW = 10;             // 대역폭 샘플 윈도우 크기

// 🚀 [Phase 3] 적응형 청크 크기 임계값
export const RTT_LOW_THRESHOLD = 50;                   // 저지연 임계값 (ms)
export const RTT_HIGH_THRESHOLD = 150;                 // 고지연 임계값 (ms)
export const LOSS_RATE_WARNING = 0.01;                 // 경고 손실률 (1%)
export const LOSS_RATE_CRITICAL = 0.05;                // 위험 손실률 (5%)
