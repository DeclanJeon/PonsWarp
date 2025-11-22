// 모바일 감지 (간단한 UA 체크)
export const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

export const APP_NAME = "PonsWarp";
export const SIGNALING_SERVER_URL = process.env.SIGNALING_SERVER_URL;

export const CHUNK_SIZE = 64 * 1024; // 64KB (유지)

// 🚀 [튜닝] 모바일 환경에 따른 동적 설정
// 모바일은 메모리가 적으므로 배치를 작게 가져가야 튕기지 않음
export const BATCH_SIZE = isMobile ? 12 : 80;

// 🚀 [튜닝] 모바일은 4MB 정도만 버퍼링 (PC는 16MB)
// iOS Safari는 탭당 메모리 제한이 엄격하므로 보수적으로 잡아야 함
export const HIGH_WATER_MARK = isMobile ? 4 * 1024 * 1024 : 16 * 1024 * 1024;

// 재개 시점도 낮춤
export const LOW_WATER_MARK = isMobile ? 1 * 1024 * 1024 : 4 * 1024 * 1024;

export const HEADER_SIZE = 18;

console.log(`[Config] Mode: ${isMobile ? 'Mobile 📱' : 'Desktop 💻'}, Batch: ${BATCH_SIZE}, Buffer: ${HIGH_WATER_MARK / 1024 / 1024}MB`);
