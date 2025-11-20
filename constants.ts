export const APP_NAME = "PonsWarp";
export const MAX_CHANNELS = 4; // Number of WebRTC DataChannels to use simultaneously
export const SIGNALING_SERVER_URL = process.env.SIGNALING_SERVER_URL;

// 🚀 [최적화 1 & 4] 청크 사이즈 상향 조정
// 64KB -> 128KB로 상향 (최신 브라우저의 SCTP 처리 능력 활용)
export const CHUNK_SIZE_INITIAL = 64 * 1024;
export const CHUNK_SIZE_MIN = 16 * 1024;
export const CHUNK_SIZE_MAX = 128 * 1024; // 128KB로 상향 (배치 처리와 결합 시 효과 극대화)

// 🚀 [최적화] WebRTC 버퍼 한계점 상향
// 4MB -> 8MB (Batch 전송을 받아낼 수 있도록 넉넉하게 확보)
export const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;
// Resume 기준점 (버퍼가 2MB 이하로 떨어지면 다시 펌핑)
export const LOW_WATER_MARK = 2 * 1024 * 1024;

// 🚀 [신규] 배치 처리 설정
export const SENDER_BATCH_SIZE = 5; // 한 번의 Pull 요청에 보낼 청크 개수
