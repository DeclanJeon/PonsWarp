export const APP_NAME = "PonsWarp";
export const SIGNALING_SERVER_URL = process.env.SIGNALING_SERVER_URL;

export const CHUNK_SIZE = 64 * 1024;
export const BATCH_SIZE = 20;

// 🚨 [수정] HIGH_WATER_MARK와 LOW_WATER_MARK를 합리적으로 설정
// 초기값이 너무 작아서 버퍼가 계속 가득 차는 현상 발생
export const HIGH_WATER_MARK = 4 * 1024 * 1024; // 4MB (송신자와 수신자 동기화)

// 🚨 [수정] 버퍼가 이 이하로 내려갈 때까지 기다림
export const LOW_WATER_MARK = 2 * 1024 * 1024;   // 2MB (빠른 재개)

export const HEADER_SIZE = 18;
