export const APP_NAME = 'PonsWarp';
export const SIGNALING_SERVER_URL =
  import.meta.env.VITE_SIGNALING_SERVER_URL || 'http://localhost:5501';

// Rust 시그널링 서버 설정
export const USE_RUST_SIGNALING =
  import.meta.env.VITE_USE_RUST_SIGNALING !== 'false';
export const RUST_SIGNALING_URL =
  import.meta.env.VITE_RUST_SIGNALING_URL || 'ws://localhost:5502/ws';

// 청크 사이징: 192KB keeps ciphertext+header safely under SCTP 256KB
export const CHUNK_SIZE_MIN = 16 * 1024; // 16KB
export const CHUNK_SIZE_INITIAL = 240 * 1024; // 240KB under SCTP 256KB
export const CHUNK_SIZE_MAX = 240 * 1024;

// 🚀 [Performance] Keep bufferedAmount modest — huge queues inflate sender
// speed while starving the real SCTP congestion window.
export const MAX_BUFFERED_AMOUNT = 6 * 1024 * 1024; // 6MB
export const LOW_WATER_MARK = 1 * 1024 * 1024; // 1MB drain
export const HIGH_WATER_MARK = 4 * 1024 * 1024; // 4MB

// 파티션 크기: 연속 전송 (ACK 불필요)
export const TRANSFER_PARTITION_SIZE = 128 * 1024 * 1024;

// 🚀 [Performance] 이벤트 기반 드레인: bufferedamountlow 사용
export const DRAIN_EVENT_WATCHDOG_MS = 100;
export const SEND_WINDOW_POLL_INTERVAL_MS = 0;
export const PARTITION_ACK_POLL_INTERVAL_MS = 10;

export const HEADER_SIZE = 22; // FileIndex(2) + ChunkIndex(4) + Offset(8) + DataLen(4) + Checksum(4)
// DNS, authenticated TURN allocation, and relay candidate gathering can exceed 15 seconds.
export const CONNECTION_TIMEOUT_MS = 45000;

// 배치 크기: 192KB x 32 = 6MB/batch
export const BATCH_SIZE_MIN = 4;
export const BATCH_SIZE_MAX = 32;
export const BATCH_SIZE_INITIAL = 16;
export const BATCH_REQUEST_SIZE = 1;

// 프리페치 버퍼: 2MB (bounded queue)
export const PREFETCH_BUFFER_SIZE = 2 * 1024 * 1024; // 2MB
export const PREFETCH_LOW_THRESHOLD = 512 * 1024; // 512KB

// 네트워크 적응형 제어 설정
export const BBR_STARTUP_GAIN = 2.89;
export const BBR_DRAIN_GAIN = 0.75;
export const BBR_PROBE_RTT_DURATION = 200;
export const RTT_SAMPLE_WINDOW = 10;
export const BANDWIDTH_SAMPLE_WINDOW = 10;

// 적응형 청크 크기 임계값
export const RTT_LOW_THRESHOLD = 50;
export const RTT_HIGH_THRESHOLD = 150;
export const LOSS_RATE_WARNING = 0.01;
export const LOSS_RATE_CRITICAL = 0.05;

// 🚀 [Multi-Channel] 데이터 채널 설정
export const DATA_CHANNEL_COUNT = 4; // legacy constant
export const PRODUCER_CONCURRENCY = 12;
export const READY_QUEUE_MAX_CHUNKS = 32;
// Parallel RTCPeerConnections for host LAN bulk transfer (separate SCTP associations)
export const LAN_STRIPE_LANES = 1; // multi-PC striping disabled: app-path still black-holes under simple-peer demux
/** Partition barrier size while multi-PC striping is active (faster gap detection). */
export const LAN_STRIPE_PARTITION_BYTES = 4 * 1024 * 1024;

