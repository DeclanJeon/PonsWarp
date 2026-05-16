export const APP_NAME = 'PonsWarp';
export const SIGNALING_SERVER_URL =
  import.meta.env.VITE_SIGNALING_SERVER_URL || 'http://localhost:5501';

// Rust 시그널링 서버 설정
export const USE_RUST_SIGNALING =
  import.meta.env.VITE_USE_RUST_SIGNALING !== 'false';
export const RUST_SIGNALING_URL =
  import.meta.env.VITE_RUST_SIGNALING_URL || 'ws://localhost:5502/ws';

// 안정성 우선 청크 사이징.
// 같은 브라우저/같은 탭에서도 64KB x 다중 배치가 실제 DataChannel drain보다
// 빠르게 쌓이면 40% 부근에서 receiver close/finalize가 멈출 수 있다.
export const CHUNK_SIZE_MIN = 16 * 1024; // 16KB
export const CHUNK_SIZE_INITIAL = 64 * 1024; // 64KB, OSS-style WebRTC transfer chunk
export const CHUNK_SIZE_MAX = 64 * 1024; // fixed until adaptive sender is re-enabled

// 🚀 [안정성 우선] WebRTC 버퍼 설정
// DataChannel bufferedAmount는 sender 로컬 큐일 뿐 receiver 저장 완료를 의미하지 않는다.
// 과도한 8~16MB 파이프라인은 실제 브라우저에서 메모리/GC 압박과 진행 정지를 만든다.
export const MAX_BUFFERED_AMOUNT = 2 * 1024 * 1024; // 2MB bounded DataChannel queue
export const LOW_WATER_MARK = 512 * 1024; // 512KB 이하에서 재개
export const HIGH_WATER_MARK = 2 * 1024 * 1024; // 2MB까지만 큐잉

// PairDrop/Snapdrop 계열처럼 일정량을 보낸 뒤 receiver writer queue가 idle될 때까지
// 기다린다. 1MB는 안정적이지만 RTT가 많은 환경에서 너무 느려 8MB까지 확장한다.
export const TRANSFER_PARTITION_SIZE = 8 * 1024 * 1024;

export const HEADER_SIZE = 22; // FileIndex(2) + ChunkIndex(4) + Offset(8) + DataLen(4) + Checksum(4)
export const CONNECTION_TIMEOUT_MS = 15000;

// 단일-flight 배치: 성능보다 drain/receiver 안정성을 우선한다.
export const BATCH_SIZE_MIN = 1;
export const BATCH_SIZE_MAX = 1;
export const BATCH_SIZE_INITIAL = 1;
export const BATCH_REQUEST_SIZE = 1; // 레거시 호환

// 🚀 프리페치 버퍼 설정
export const PREFETCH_BUFFER_SIZE = 0;
export const PREFETCH_LOW_THRESHOLD = 0;

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
