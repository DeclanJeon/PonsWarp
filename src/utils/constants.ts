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
export const CHUNK_SIZE_INITIAL = 192 * 1024; // 192KB, below common 256KB SCTP message limits
export const CHUNK_SIZE_MAX = 192 * 1024; // fixed until adaptive sender is re-enabled

// 🚀 [안정성 우선] WebRTC 버퍼 설정
// DataChannel bufferedAmount는 sender 로컬 큐일 뿐 receiver 저장 완료를 의미하지 않는다.
// 과도한 8~16MB 파이프라인은 실제 브라우저에서 메모리/GC 압박과 진행 정지를 만든다.
// 4MB queue는 앞선 production smoke에서 안정적이었다. 추가 튜닝은 큐를 더 키우지
// 않고 chunk/대기 latency를 줄이는 쪽으로 제한한다.
export const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024; // 4MB bounded DataChannel queue
export const LOW_WATER_MARK = 1024 * 1024; // 1MB 이하에서 재개
export const HIGH_WATER_MARK = 4 * 1024 * 1024; // 4MB까지만 큐잉

// PairDrop/Snapdrop 계열처럼 일정량을 보낸 뒤 receiver writer queue가 idle될 때까지
// 기다린다. 16MB는 receiver PAUSE(32MB) 절반 이하라 안전 여유를 남기며 ACK RTT를 줄인다.
export const TRANSFER_PARTITION_SIZE = 16 * 1024 * 1024;

// Partitioned sender의 busy polling 지연. 25~50ms는 localhost/빠른 LAN에서
// DataChannel을 자주 굶기므로 짧은 fallback tick과 drain/ACK wake-up을 병행한다.
export const SEND_WINDOW_POLL_INTERVAL_MS = 5;
export const PARTITION_ACK_POLL_INTERVAL_MS = 10;

export const HEADER_SIZE = 22; // FileIndex(2) + ChunkIndex(4) + Offset(8) + DataLen(4) + Checksum(4)
// DNS, authenticated TURN allocation, and relay candidate gathering can exceed 15 seconds.
export const CONNECTION_TIMEOUT_MS = 45000;

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
