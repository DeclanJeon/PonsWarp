/**
 * Worker Factory
 * V2 Worker 파일을 로드하여 인스턴스를 생성합니다.
 * 불필요한 문자열 기반 코드를 제거하고 Vite 모듈 시스템을 활용합니다.
 */

export const getSenderWorkerV1 = (): Worker => {
  return new Worker(
    new URL('../workers/file-sender.worker.v2.ts', import.meta.url),
    { type: 'module' }
  );
};

export const getReceiverWorkerV1 = (): Worker => {
  return new Worker(
    new URL('../workers/file-receiver.worker.v2.ts', import.meta.url),
    { type: 'module' }
  );
};
