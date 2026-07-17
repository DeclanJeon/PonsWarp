import type { TransferEvent } from '../transfer/events';
import type { TransferOutputPort } from '../transfer/ports';
import type { TransferState } from '../transfer/state';
/**
 * Store Connector
 *
 * 서비스 레이어(SwarmManager, webRTCService)와 Zustand Store를 연결하는 브릿지.
 * UI 컴포넌트를 거치지 않고 서비스에서 직접 상태를 업데이트할 수 있게 해줍니다.
 *
 * 🚀 성능 최적화:
 * - 스로틀링된 진행률 업데이트
 * - 배치 상태 업데이트
 */

import {
  useTransferStore,
  ProgressData,
  TransferStatus,
} from '../store/transferStore';

// 스로틀링 설정
const PROGRESS_THROTTLE_MS = 33; // ~30fps
let lastProgressUpdate = 0;

/**
 * 진행률 업데이트 (스로틀링 적용)
 * SwarmManager나 webRTCService에서 직접 호출 가능
 */
export const updateProgress = (data: Partial<ProgressData>) => {
  const now = Date.now();
  if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS) {
    lastProgressUpdate = now;
    useTransferStore.getState().updateProgress(data);
  }
};

/**
 * 상태 업데이트 (즉시 반영)
 */
export const setStatus = (status: TransferStatus) => {
  useTransferStore.getState().setStatus(status);
};

/**
 * 에러 설정
 */
export const setError = (error: string | null) => {
  useTransferStore.getState().setError(error);
};

/**
 * 피어 연결 추가
 */
export const addConnectedPeer = (peerId: string) => {
  useTransferStore.getState().addConnectedPeer(peerId);
};

/**
 * 피어 연결 제거
 */
export const removeConnectedPeer = (peerId: string) => {
  useTransferStore.getState().removeConnectedPeer(peerId);
};

/**
 * Ready 피어 추가
 */
export const addReadyPeer = (peerId: string) => {
  useTransferStore.getState().addReadyPeer(peerId);
};

/**
 * 완료된 피어 추가
 */
export const addCompletedPeer = (peerId: string) => {
  useTransferStore.getState().addCompletedPeer(peerId);
};

/**
 * 대기열 피어 추가
 */
export const addQueuedPeer = (peerId: string) => {
  useTransferStore.getState().addQueuedPeer(peerId);
};

/**
 * 대기열 초기화
 */
export const clearQueuedPeers = () => {
  useTransferStore.getState().clearQueuedPeers();
};

/**
 * Ready 카운트다운 설정
 */
export const setReadyCountdown = (countdown: number | null) => {
  useTransferStore.getState().setReadyCountdown(countdown);
};

/**
 * 전체 상태 리셋
 */
export const resetStore = () => {
  useTransferStore.getState().reset();
};

/**
 * 새 전송을 위한 부분 리셋
 */
export const resetForNewTransfer = () => {
  useTransferStore.getState().resetForNewTransfer();
};

/**
 * 현재 상태 조회 (디버깅용)
 */
export const getStoreState = () => {
  return useTransferStore.getState();
};
/** Adapts framework-free transfer state/events to the legacy Zustand store. */
export const projectTransferState = (state: TransferState) => {
  const status: TransferStatus =
    state.status === 'connecting' ? 'CONNECTING' :
    state.status === 'ready' ? 'READY_FOR_NEXT' :
    state.status === 'transferring' ? (state.role === 'receiver' ? 'RECEIVING' : 'TRANSFERRING') :
    state.status === 'completed' ? 'DONE' :
    state.status === 'error' || state.status === 'timed_out' ? 'ERROR' : 'IDLE';
  setStatus(status);
  const progress = {
    bytesTransferred: state.bytes,
    totalBytes: state.totalBytes,
    progress: state.totalBytes > 0 ? state.bytes / state.totalBytes : 0,
  };
  if (state.terminal) {
    useTransferStore.getState().updateProgress(progress);
  } else {
    updateProgress(progress);
  }
  setError(state.error ?? null);
};

export const createStoreTransferOutputPort = (): TransferOutputPort => ({
  emit: projectTransferEvent,
});

const projectTransferEvent = (event: TransferEvent) => {
  if (event.type === 'progress' || event.type === 'resume') {
    updateProgress({
      bytesTransferred: event.bytes ?? 0,
      totalBytes: event.type === 'progress' ? event.totalBytes : undefined,
      progress: event.type === 'progress' && event.totalBytes > 0 ? event.bytes / event.totalBytes : undefined,
    });
  } else if (event.type === 'complete') {
    setStatus('DONE');
    setError(null);
  } else if (event.type === 'error' || event.type === 'timeout') {
    setStatus('ERROR');
    setError(event.error ?? 'Transfer timed out');
  } else if (event.type === 'cancel') {
    setStatus('IDLE');
    setError(null);
  }
};

export const transferOutputPort = createStoreTransferOutputPort();
