export const APP_NAME = "PonsWarp";
export const MAX_CHANNELS = 4; // Number of WebRTC DataChannels to use simultaneously
export const SIGNALING_SERVER_URL = process.env.SIGNALING_SERVER_URL;

// 🚀 [최적화] 청크 사이즈 (64KB로 조정)
export const CHUNK_SIZE_INITIAL = 64 * 1024;
export const CHUNK_SIZE_MIN = 16 * 1024;
export const CHUNK_SIZE_MAX = 64 * 1024;

// 🚀 [핵심 수정] WebRTC 버퍼 설정 대폭 상향
// 기존 256KB -> 4MB로 상향 (대역폭이 큰 환경에서 속도 확보)
export const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024;
// Resume 기준점도 상향 (버퍼가 절반 비면 재개)
export const LOW_WATER_MARK = 1 * 1024 * 1024;
