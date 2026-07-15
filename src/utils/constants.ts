export const APP_NAME = 'PonsWarp';
export const SIGNALING_SERVER_URL =
  import.meta.env.VITE_SIGNALING_SERVER_URL || 'http://localhost:5501';

// Rust 시그널링 서버 설정
export const USE_RUST_SIGNALING =
  import.meta.env.VITE_USE_RUST_SIGNALING !== 'false';
export const RUST_SIGNALING_URL =
  import.meta.env.VITE_RUST_SIGNALING_URL || 'ws://localhost:5502/ws';

// 청크 사이징: 192KB는 SCTP 협상 기본값 64KB 대비 3배 효율, 안전 마진 확보
export const CHUNK_SIZE_MIN = 16 * 1024; // 16KB
export const CHUNK_SIZE_INITIAL = 192 * 1024; // 192KB - SCTP 안전 마진
export const CHUNK_SIZE_MAX = 240 * 1024; // 최대 240KB (SCTP 256KB 한도)

// 🚀 [Performance] 워터마크 최적화: drain 이벤트 기반으로 전환, sawtooth 파동 감소
export const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024; // 16MB - 깊은 파이프라인
export const LOW_WATER_MARK = 4 * 1024 * 1024; // 4MB - 드레인 임계값 상향 (기존 2MB)
export const HIGH_WATER_MARK = 12 * 1024 * 1024; // 12MB - 상류 재개 임계값

// 파티션 크기: 64MB로 확대 (기존 16MB). ACK 오버헤드 감소, 스트림 연속성 향상
export const TRANSFER_PARTITION_SIZE = 64 * 1024 * 1024;

// 🚀 [Performance] 폴링 제거: bufferedamountlow 이벤트 기반 드레인
export const DRAIN_EVENT_WATCHDOG_MS = 250;
export const SEND_WINDOW_POLL_INTERVAL_MS = 0; // 이벤트 기반으로 전환
export const PARTITION_ACK_POLL_INTERVAL_MS = 0; // 이벤트 기반으로 전환

export const HEADER_SIZE = 22; // FileIndex(2) + ChunkIndex(4) + Offset(8) + DataLen(4) + Checksum(4)
// DNS, authenticated TURN allocation, and relay candidate gathering can exceed 15 seconds.
export const CONNECTION_TIMEOUT_MS = 45000;

// 🚀 [Performance] 배치 크기 확대: 연속 스트리밍 전송
// 기존 4개 배치 = 960KB → 배치당 최대 48개 = 9.2MB 연속 전송
export const BATCH_SIZE_MIN = 4;
export const BATCH_SIZE_MAX = 48; // 48 x 192KB = 9.2MB per batch
export const BATCH_SIZE_INITIAL = 16; // 16 x 192KB = 3MB per batch
export const BATCH_REQUEST_SIZE = 1; // 레거시 호환

// 🚀 [Performance] 프리페치 버퍼 확대: 16MB (기존 4MB)
export const PREFETCH_BUFFER_SIZE = 16 * 1024 * 1024; // 16MB 프리페치
export const PREFETCH_LOW_THRESHOLD = 4 * 1024 * 1024; // 4MB

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
