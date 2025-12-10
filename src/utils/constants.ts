export const APP_NAME = 'PonsWarp';
export const SIGNALING_SERVER_URL =
  import.meta.env.VITE_SIGNALING_SERVER_URL || 'http://localhost:5501';

// Rust 시그널링 서버 설정
export const USE_RUST_SIGNALING =
  import.meta.env.VITE_USE_RUST_SIGNALING === 'true';
export const RUST_SIGNALING_URL =
  import.meta.env.VITE_RUST_SIGNALING_URL || 'ws://localhost:5502/ws';

// 🚀 청크 사이징 (128KB 브라우저 제한)
export const CHUNK_SIZE_MIN = 16 * 1024; // 16KB
export const CHUNK_SIZE_INITIAL = 64 * 1024; // 64KB
export const CHUNK_SIZE_MAX = 128 * 1024; // 128KB (브라우저 한계)

// 🚀 [성능 최적화] WebRTC 버퍼 설정 - 공격적 파이프라이닝 적용
// 60Mbps 환경에서 끊김 없는 전송을 위해 마진을 크게 확보
export const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024; // 16MB (기존 8MB -> 2배 증대)
export const LOW_WATER_MARK = 4 * 1024 * 1024; // 4MB (이하로 떨어지면 즉시 리필)
export const HIGH_WATER_MARK = 12 * 1024 * 1024; // 12MB (여기까지 꽉 채움)

export const HEADER_SIZE = 22; // FileIndex(2) + ChunkIndex(4) + Offset(8) + DataLen(4) + Checksum(4)
export const CONNECTION_TIMEOUT_MS = 15000;

// 🚀 [성능 최적화] 배치 설정 - IPC 오버헤드 감소
export const BATCH_SIZE_MIN = 32; // 최소 32개 (약 4MB) - 기존 16에서 상향
export const BATCH_SIZE_MAX = 128; // 최대 128개 (약 16MB) - 기존 32에서 상향
export const BATCH_SIZE_INITIAL = 64; // 초기 64개 (약 8MB) -> Start-up 가속
export const BATCH_REQUEST_SIZE = 64; // 레거시 호환

// 🚀 프리페치 버퍼 설정
export const PREFETCH_BUFFER_SIZE = 32 * 1024 * 1024; // 32MB
export const PREFETCH_LOW_THRESHOLD = 8 * 1024 * 1024; // 8MB

// 🚀 [Phase 3] 네트워크 적응형 제어 설정
export const BBR_STARTUP_GAIN = 2.89; // BBR Startup 모드 gain
export const BBR_DRAIN_GAIN = 0.75; // BBR Drain 모드 gain
export const BBR_PROBE_RTT_DURATION = 200; // ProbeRTT 지속 시간 (ms)
export const RTT_SAMPLE_WINDOW = 10; // RTT 샘플 윈도우 크기
export const BANDWIDTH_SAMPLE_WINDOW = 10; // 대역폭 샘플 윈도우 크기

// 🚀 [Phase 3] 적응형 청크 크기 임계값
export const RTT_LOW_THRESHOLD = 50; // 저지연 임계값 (ms)
export const RTT_HIGH_THRESHOLD = 150; // 고지연 임계값 (ms)
export const LOSS_RATE_WARNING = 0.01; // 경고 손실률 (1%)
export const LOSS_RATE_CRITICAL = 0.05; // 위험 손실률 (5%)
