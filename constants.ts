export const APP_NAME = "PonsWarp";
export const MAX_CHANNELS = 4;

// [수정] Vite 환경 변수(import.meta.env)를 우선적으로 사용
// Vite 빌드 시 process.env는 제한적이므로 import.meta.env가 표준입니다.
export const SIGNALING_SERVER_URL =
  (import.meta as any).env?.VITE_SIGNALING_SERVER_URL ||
  process.env.SIGNALING_SERVER_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5501');

export const CHUNK_SIZE_INITIAL = 64 * 1024;
export const CHUNK_SIZE_MIN = 16 * 1024;
export const CHUNK_SIZE_MAX = 128 * 1024;

export const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;
export const LOW_WATER_MARK = 2 * 1024 * 1024;
export const SENDER_BATCH_SIZE = 5;
