/**
 * Transfer Store - Zustand 기반 중앙 집중식 상태 관리
 * 
 * 🚀 성능 최적화:
 * - 고빈도 업데이트(progress)를 위한 transient updates 지원
 * - Selector 패턴으로 불필요한 리렌더링 방지
 * - 서비스 레이어에서 직접 상태 업데이트 가능
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { TransferManifest, AppMode } from '../types';

// 피어 상태 인터페이스
export interface PeerInfo {
  id: string;
  status: 'connected' | 'ready' | 'transferring' | 'complete' | 'queued';
}

// 진행률 데이터 인터페이스
export interface ProgressData {
  progress: number;
  speed: number;
  bytesTransferred: number;
  totalBytes: number;
}

// 전체 상태 인터페이스
interface TransferState {
  // 앱 모드
  mode: AppMode;
  
  // 방 정보
  roomId: string | null;
  shareLink: string | null;
  
  // 상태
  status: 'IDLE' | 'DRAGGING_FILES' | 'PREPARING' | 'WAITING' | 'CONNECTING' | 'TRANSFERRING' | 'REMOTE_PROCESSING' | 'READY_FOR_NEXT' | 'DONE' | 'ERROR' | 'QUEUED' | 'ROOM_FULL';
  error: string | null;
  
  // 메타데이터
  manifest: TransferManifest | null;
  
  // 진행률 (자주 변경됨)
  progress: ProgressData;
  
  // 피어 정보 (Sender용)
  connectedPeers: string[];
  readyPeers: string[];
  completedPeers: string[];
  queuedPeers: string[];
  readyCountdown: number | null;
  currentTransferPeerCount: number;
  waitingPeersCount: number;
  
  // 액션
  setMode: (mode: AppMode) => void;
  setRoomId: (id: string | null) => void;
  setShareLink: (link: string | null) => void;
  setStatus: (status: TransferState['status']) => void;
  setError: (error: string | null) => void;
  setManifest: (manifest: TransferManifest | null) => void;
  
  // 드래그/전송 상태 헬퍼
  startDragging: () => void;
  stopDragging: () => void;
  startTransfer: () => void;
  completeTransfer: () => void;
  
  // 🚀 진행률 업데이트 (고빈도 - 스로틀링 권장)
  updateProgress: (data: Partial<ProgressData>) => void;
  
  // 피어 관리
  addConnectedPeer: (peerId: string) => void;
  removeConnectedPeer: (peerId: string) => void;
  addReadyPeer: (peerId: string) => void;
  removeReadyPeer: (peerId: string) => void;
  addCompletedPeer: (peerId: string) => void;
  addQueuedPeer: (peerId: string) => void;
  clearQueuedPeers: () => void;
  setReadyCountdown: (countdown: number | null) => void;
  setCurrentTransferPeerCount: (count: number) => void;
  setWaitingPeersCount: (count: number) => void;
  
  // 전체 리셋
  reset: () => void;
  
  // Sender 상태 리셋 (새 전송 시작 시)
  resetForNewTransfer: () => void;
}

// 초기 진행률 상태
const initialProgress: ProgressData = {
  progress: 0,
  speed: 0,
  bytesTransferred: 0,
  totalBytes: 0,
};

// 초기 상태
const initialState = {
  mode: AppMode.INTRO,
  roomId: null,
  shareLink: null,
  status: 'IDLE' as const,
  error: null,
  manifest: null,
  progress: initialProgress,
  connectedPeers: [],
  readyPeers: [],
  completedPeers: [],
  queuedPeers: [],
  readyCountdown: null,
  currentTransferPeerCount: 0,
  waitingPeersCount: 0,
};

export const useTransferStore = create<TransferState>()(
  subscribeWithSelector((set, get) => ({
    ...initialState,
    
    // 기본 setter
    setMode: (mode) => set({ mode }),
    setRoomId: (roomId) => set({ roomId }),
    setShareLink: (shareLink) => set({ shareLink }),
    setStatus: (status) => set({ status }),
    setError: (error) => set({ error }),
    setManifest: (manifest) => set({ manifest }),
    
    // 🚀 진행률 업데이트 (성능 최적화: 필요한 필드만 업데이트)
    updateProgress: (data) => set((state) => ({
      progress: {
        ...state.progress,
        ...data,
      }
    })),
    
    // 드래그/전송 상태 헬퍼
    startDragging: () => set({ status: 'DRAGGING_FILES' }),
    stopDragging: () => set({ status: 'IDLE' }),
    startTransfer: () => set({ status: 'TRANSFERRING' }),
    completeTransfer: () => set({ status: 'DONE' }),
    
    // 피어 관리
    addConnectedPeer: (peerId) => set((state) => ({
      connectedPeers: state.connectedPeers.includes(peerId) 
        ? state.connectedPeers 
        : [...state.connectedPeers, peerId]
    })),
    
    removeConnectedPeer: (peerId) => set((state) => ({
      connectedPeers: state.connectedPeers.filter(id => id !== peerId),
      readyPeers: state.readyPeers.filter(id => id !== peerId),
    })),
    
    addReadyPeer: (peerId) => set((state) => ({
      readyPeers: state.readyPeers.includes(peerId)
        ? state.readyPeers
        : [...state.readyPeers, peerId]
    })),
    
    removeReadyPeer: (peerId) => set((state) => ({
      readyPeers: state.readyPeers.filter(id => id !== peerId)
    })),
    
    addCompletedPeer: (peerId) => set((state) => ({
      completedPeers: state.completedPeers.includes(peerId)
        ? state.completedPeers
        : [...state.completedPeers, peerId],
      // 완료된 피어는 readyPeers에서 제거
      readyPeers: state.readyPeers.filter(id => id !== peerId)
    })),
    
    addQueuedPeer: (peerId) => set((state) => ({
      queuedPeers: state.queuedPeers.includes(peerId)
        ? state.queuedPeers
        : [...state.queuedPeers, peerId]
    })),
    
    clearQueuedPeers: () => set({ queuedPeers: [] }),
    
    setReadyCountdown: (countdown) => set({ readyCountdown: countdown }),
    setCurrentTransferPeerCount: (count) => set({ currentTransferPeerCount: count }),
    setWaitingPeersCount: (count) => set({ waitingPeersCount: count }),
    
    // 전체 리셋
    reset: () => set(initialState),
    
    // 새 전송을 위한 부분 리셋
    resetForNewTransfer: () => set({
      status: 'IDLE',
      error: null,
      progress: initialProgress,
      completedPeers: [],
      queuedPeers: [],
      readyCountdown: null,
      currentTransferPeerCount: 0,
      waitingPeersCount: 0,
    }),
  }))
);

// 🚀 성능 최적화: 스로틀된 진행률 업데이트 함수
// 서비스 레이어에서 직접 호출 가능
let lastProgressUpdate = 0;
const PROGRESS_THROTTLE_MS = 33; // ~30fps

export const throttledUpdateProgress = (data: Partial<ProgressData>) => {
  const now = Date.now();
  if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS) {
    lastProgressUpdate = now;
    useTransferStore.getState().updateProgress(data);
  }
};

// 🚀 Selector 헬퍼: 특정 상태만 구독
export const selectProgress = (state: TransferState) => state.progress;
export const selectStatus = (state: TransferState) => state.status;
export const selectManifest = (state: TransferState) => state.manifest;
export const selectPeerCounts = (state: TransferState) => ({
  connected: state.connectedPeers.length,
  ready: state.readyPeers.length,
  completed: state.completedPeers.length,
  queued: state.queuedPeers.length,
});
