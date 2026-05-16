// 🚨 [DEBUG] 아키텍처 불일치 진단 로그 추가
debugLog('[SwarmManager] ✅ [DEBUG] ARCHITECTURE CONSISTENT:');
debugLog(
  '[SwarmManager] ✅ [DEBUG] - Using SinglePeerConnection class (correct)'
);
debugLog('[SwarmManager] ✅ [DEBUG] - SenderView uses SwarmManager (correct)');
debugLog(
  '[SwarmManager] ✅ [DEBUG] - Dedicated Sender-only implementation (correct)'
);

import {
  SinglePeerConnection,
  PeerConfig,
  PeerState,
} from './singlePeerConnection';
import { getSignalingService } from './signaling-factory';

// 팩토리를 통해 시그널링 서비스 가져오기
const signalingService = getSignalingService();
import { getSenderWorkerV1 } from './workerFactory';
import { TransferManifest } from '../types/types';
import {
  logInfo,
  logError,
  logDebug,
  logWarn,
  debugLog,
} from '../utils/logger';
import {
  HIGH_WATER_MARK,
  HEADER_SIZE,
  BATCH_SIZE_INITIAL,
  CHUNK_SIZE_INITIAL,
  PARTITION_ACK_POLL_INTERVAL_MS,
  SEND_WINDOW_POLL_INTERVAL_MS,
  TRANSFER_PARTITION_SIZE,
} from '../utils/constants';
import { createEosPacket, createPlainDataPacket } from '../utils/plainPacket';
import { bytesToBase64, CryptoService } from './cryptoService';
import { networkController, AdaptiveParams } from './networkAdaptiveController';
import { calculateProgressPercent } from '../utils/transferProgress';
import {
  calculateSafeBatchRequestSize,
  getPacketPayloadSize,
  isPrematureTransferComplete,
  shouldRequestMoreChunks,
} from '../utils/transferFlowControl';
import { getPartitionedResumeCursor } from '../utils/mobileResumePolicy';

// 핵심 안전 상수: 절대 변경 금지
export const MAX_DIRECT_PEERS = 3;
const CONNECTION_TIMEOUT = 30000; // 30초
const READY_WAIT_TIME_1N = 10000; // 1:N 상황에서 대기 시간 (10초)

export interface SwarmState {
  roomId: string | null;
  peerCount: number;
  connectedCount: number;
  readyCount: number;
  isTransferring: boolean;
  highestBufferedAmount: number;
}

export interface BroadcastResult {
  successCount: number;
  failedPeers: string[];
  sentPeers: string[];
}

export interface SwarmProgress {
  totalBytesSent: number;
  totalBytes: number;
  overallProgress: number;
  speed: number;
  peers: PeerState[];
}

type EventHandler = (data: unknown) => void;
type PeerSignalData = Parameters<SinglePeerConnection['signal']>[0];
type SignalingPeerMessage = {
  from?: string;
  socketId?: string;
  offer?: PeerSignalData;
  answer?: PeerSignalData;
  candidate?: PeerSignalData;
};
type OutgoingSignalMessage = PeerSignalData & {
  type?: 'offer' | 'answer';
  candidate?: unknown;
};
type ControlMessage = {
  type?: string;
  action?: 'PAUSE' | 'RESUME' | 'ACK';
  offset?: unknown;
  actualSize?: unknown;
};
type WorkerProgressData = Partial<SwarmProgress> & {
  progress?: number;
};
type WorkerBatchPayload = {
  chunks: ArrayBuffer[];
  progressData?: WorkerProgressData;
};

export class SwarmManager {
  private peers: Map<string, SinglePeerConnection> = new Map();
  private roomId: string | null = null;
  private worker: Worker | null = null;
  private isTransferring: boolean = false;
  private pendingManifest: TransferManifest | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};

  public on(event: string, handler: EventHandler): void {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(handler);
  }

  public off(event: string, handler: EventHandler): void {
    if (!this.eventListeners[event]) return;
    this.eventListeners[event] = this.eventListeners[event].filter(
      h => h !== handler
    );
  }

  private emit(event: string, data?: unknown): void {
    this.eventListeners[event]?.forEach(h => h(data));
  }

  public removeAllListeners(): void {
    this.eventListeners = {};
  }

  // Backpressure 제어
  private isProcessingBatch = false;
  private currentBatchSize = BATCH_SIZE_INITIAL;

  // 연결 타임아웃 관리
  private connectionTimeouts: Map<string, ReturnType<typeof setTimeout>> =
    new Map();

  // ICE 서버 설정
  private iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
  ];

  // 진행률 추적
  private totalBytesSent = 0;
  private totalBytes = 0;
  private transferStartTime = 0;

  // Keep-alive/flow-control 타이머
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  private adaptiveStatsInterval: ReturnType<typeof setInterval> | null = null;
  private transferPumpInterval: ReturnType<typeof setInterval> | null = null;
  private workerBatchTimeout: ReturnType<typeof setTimeout> | null = null;

  // 🚀 [Flow Control] 원격 피어의 일시정지 상태 추적
  private pausedPeers: Set<string> = new Set();
  private pendingAckPeers: Set<string> = new Set();
  private partitionAckWaiters: Map<number, Set<string>> = new Map();
  private sendWindowWaiters: Set<() => void> = new Set();
  private awaitingReceiverReconnect = false;

  // 🚀 [대기열 시스템]
  private transferQueue: string[] = []; // ready 대기열
  private completedPeersInSession: Set<string> = new Set(); // 현재 세션에서 완료된 피어
  private currentTransferPeers: Set<string> = new Set(); // 현재 전송 중인 피어들
  private files: File[] = []; // 전송할 파일 저장
  private allTransfersCompleteEmitted = false;

  // 🔐 [E2E Encryption]
  private cryptoService: CryptoService | null = null;
  private encryptionEnabled: boolean = false;
  private sessionKey: Uint8Array | null = null;
  private randomPrefix: Uint8Array | null = null;
  private cryptoSessionAnnouncedPeers: Set<string> = new Set();
  private lastAdaptiveConfig: AdaptiveParams | null = null;

  // Bound Handlers to allow removal
  private boundHandlePeerJoined = this.handlePeerJoined.bind(this);
  private boundHandleOffer = this.handleOffer.bind(this);
  private boundHandleAnswer = this.handleAnswer.bind(this);
  private boundHandleIceCandidate = this.handleIceCandidate.bind(this);
  private boundHandleUserLeft = this.handleUserLeft.bind(this);
  private boundHandleRoomFull = () => {
    this.emit('room-full', 'Room is at maximum capacity');
  };

  constructor() {
    debugLog('[SwarmManager] 🆕 Initializing new instance');
    this.setupSignalingHandlers();
  }

  /**
   * 🔐 E2E 암호화 활성화
   */
  public enableEncryption(): void {
    this.cryptoService = new CryptoService();
    this.encryptionEnabled = true;
    logInfo('[SwarmManager]', '🔐 E2E encryption enabled');
  }

  /**
   * 🔐 암호화 서비스 반환 (핸드셰이크용)
   */
  public getCryptoService(): CryptoService | null {
    return this.cryptoService;
  }

  /**
   * 🔐 세션 키 설정 (핸드셰이크 완료 후)
   */
  public setSessionKey(sessionKey: Uint8Array, randomPrefix: Uint8Array): void {
    this.sessionKey = sessionKey;
    this.randomPrefix = randomPrefix;
    logInfo('[SwarmManager]', '🔐 Session key set');
  }

  private ensureTransferEncryption(): void {
    if (this.sessionKey && this.randomPrefix) {
      this.encryptionEnabled = true;
      return;
    }

    this.sessionKey = crypto.getRandomValues(new Uint8Array(32));
    this.randomPrefix = crypto.getRandomValues(new Uint8Array(8));
    this.encryptionEnabled = true;
    logInfo('[SwarmManager]', '🔐 Transfer encryption session generated');
  }

  private sendCryptoSessionToPeer(peer: SinglePeerConnection): void {
    if (!this.isEncryptionEnabled() || !this.sessionKey || !this.randomPrefix) {
      return;
    }

    if (this.cryptoSessionAnnouncedPeers.has(peer.id)) {
      return;
    }

    peer.send(
      JSON.stringify({
        type: 'CRYPTO_SESSION',
        version: 1,
        algorithm: 'AES-256-GCM',
        key: bytesToBase64(this.sessionKey),
        randomPrefix: bytesToBase64(this.randomPrefix),
      })
    );
    this.cryptoSessionAnnouncedPeers.add(peer.id);
  }

  /**
   * 🔐 암호화 활성화 여부
   */
  public isEncryptionEnabled(): boolean {
    return this.encryptionEnabled && this.sessionKey !== null;
  }

  private setupSignalingHandlers(): void {
    signalingService.on('peer-joined', this.boundHandlePeerJoined);
    signalingService.on('offer', this.boundHandleOffer);
    signalingService.on('answer', this.boundHandleAnswer);
    signalingService.on('ice-candidate', this.boundHandleIceCandidate);
    signalingService.on('user-left', this.boundHandleUserLeft);
    signalingService.on('room-full', this.boundHandleRoomFull);
  }

  private removeSignalingHandlers(): void {
    signalingService.off('peer-joined', this.boundHandlePeerJoined);
    signalingService.off('offer', this.boundHandleOffer);
    signalingService.off('answer', this.boundHandleAnswer);
    signalingService.off('ice-candidate', this.boundHandleIceCandidate);
    signalingService.off('user-left', this.boundHandleUserLeft);
    signalingService.off('room-full', this.boundHandleRoomFull);
  }

  // ======================= 피어 관리 =======================

  /**
   * 새 피어 추가 (슬롯 제한 적용)
   */
  public addPeer(
    peerId: string,
    initiator: boolean
  ): SinglePeerConnection | null {
    // 핵심 안전 검사: 슬롯 제한
    if (this.peers.size >= MAX_DIRECT_PEERS) {
      logError(
        '[SwarmManager]',
        `Slot limit reached (${MAX_DIRECT_PEERS}). Rejecting peer: ${peerId}`
      );
      this.emit('peer-rejected', { peerId, reason: 'slot-limit' });
      return null;
    }

    // 이미 존재하는 피어 확인
    if (this.peers.has(peerId)) {
      logInfo('[SwarmManager]', `Peer already exists: ${peerId}`);
      return this.peers.get(peerId)!;
    }

    const config: PeerConfig = {
      iceServers: this.iceServers,
    };

    const peer = new SinglePeerConnection(peerId, initiator, config);
    this.setupPeerEventHandlers(peer);
    this.peers.set(peerId, peer);
    this.setupConnectionTimeout(peerId);

    logInfo(
      '[SwarmManager]',
      `Peer added: ${peerId} (${this.peers.size}/${MAX_DIRECT_PEERS})`
    );
    return peer;
  }

  /**
   * 피어 제거
   */
  public removePeer(peerId: string, reason: string = 'unknown'): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    this.clearConnectionTimeout(peerId);
    peer.destroy();
    this.peers.delete(peerId);

    // 🚀 [중요] 상태 정리
    this.pausedPeers.delete(peerId);
    this.transferQueue = this.transferQueue.filter(id => id !== peerId);

    // 전송 중이던 피어가 나가면 즉시 제거하여 다른 피어가 기다리지 않게 함
    if (this.currentTransferPeers.has(peerId)) {
      this.currentTransferPeers.delete(peerId);
      logWarn(
        '[SwarmManager]',
        `Active peer ${peerId} dropped. Removed from transfer set.`
      );

      // 만약 이 피어가 나가서 남은 피어가 없다면 완료 처리 시도
      if (this.isTransferring && this.currentTransferPeers.size === 0) {
        this.checkTransferComplete();
      } else if (this.isTransferring) {
        // 다른 피어가 있다면 Flow Control 재평가 (나간 피어가 PAUSE 상태였을 수 있음)
        if (this.canRequestMoreChunks()) {
          this.requestMoreChunks();
        }
      }
    }

    logInfo('[SwarmManager]', `Peer removed: ${peerId} (reason: ${reason})`);
    this.emit('peer-disconnected', { peerId, reason });

    // 모든 피어가 연결 해제되면 전송 실패
    if (this.isTransferring && this.peers.size === 0) {
      if (this.canResumeSingleFileTransfer()) {
        this.awaitingReceiverReconnect = true;
        this.isTransferring = false;
        this.isProcessingBatch = false;
        this.pendingAckPeers.clear();
        this.partitionAckWaiters.clear();
        this.notifySendWindowWaiters();
        this.emit('status', 'WAITING_FOR_RECONNECT');
        logWarn(
          '[SwarmManager]',
          'All receivers disconnected during transfer; keeping sender session alive for mobile resume'
        );
        return;
      }

      this.emit('transfer-failed', 'All peers disconnected');
      this.cleanup();
    }
  }

  /**
   * 피어 조회
   */
  public getPeer(peerId: string): SinglePeerConnection | undefined {
    return this.peers.get(peerId);
  }

  /**
   * 피어 수 조회
   */
  public getPeerCount(): number {
    return this.peers.size;
  }

  /**
   * 연결된 피어 목록 조회
   */
  public getConnectedPeers(): SinglePeerConnection[] {
    return Array.from(this.peers.values()).filter(p => p.connected);
  }

  /**
   * Ready 상태인 피어 수 조회
   */
  public getReadyPeerCount(): number {
    return Array.from(this.peers.values()).filter(p => p.ready).length;
  }

  private setupPeerEventHandlers(peer: SinglePeerConnection): void {
    peer.on<OutgoingSignalMessage>('signal', data => {
      this.forwardSignal(peer.id, data);
    });

    peer.on<string>('connected', peerId => {
      this.clearConnectionTimeout(peerId);
      logInfo('[SwarmManager]', `Peer connected: ${peerId}`);
      this.emit('peer-connected', peerId);

      // Sender인 경우 Manifest 전송
      if (this.pendingManifest) {
        this.sendCryptoSessionToPeer(peer);
        this.sendManifestToPeer(peer);
      }

      // Keep-alive 시작
      this.startKeepAlive();
    });

    peer.on<ArrayBuffer | string>('data', data => {
      this.handlePeerData(peer.id, data);
    });

    peer.on<string>('drain', peerId => {
      this.handleDrain(peerId);
    });

    peer.on('error', error => {
      logError('[SwarmManager]', `Peer error (${peer.id}):`, error);
      this.removePeer(peer.id, 'error');
    });

    peer.on('close', () => {
      this.removePeer(peer.id, 'closed');
    });
  }

  private setupConnectionTimeout(peerId: string): void {
    const timeout = setTimeout(() => {
      const peer = this.peers.get(peerId);
      if (peer && !peer.connected) {
        logError('[SwarmManager]', `Connection timeout: ${peerId}`);
        this.emit('peer-timeout', peerId);
        this.removePeer(peerId, 'timeout');
      }
    }, CONNECTION_TIMEOUT);

    this.connectionTimeouts.set(peerId, timeout);
  }

  private clearConnectionTimeout(peerId: string): void {
    const timeout = this.connectionTimeouts.get(peerId);
    if (timeout) {
      clearTimeout(timeout);
      this.connectionTimeouts.delete(peerId);
    }
  }

  // ======================= 시그널링 =======================

  private handlePeerJoined(data: SignalingPeerMessage): void {
    debugLog('[SwarmManager] 👤 handlePeerJoined called with:', data);

    // roomId가 설정되지 않았으면 무시 (아직 초기화되지 않음)
    if (!this.roomId) {
      console.warn('[SwarmManager] ⚠️ handlePeerJoined ignored: No roomId set');
      return;
    }

    const peerId = data?.socketId || data?.from;
    if (!peerId) return;

    // 자기 자신은 무시
    if (peerId === signalingService.getSocketId()) {
      debugLog('[SwarmManager] ℹ️ handlePeerJoined ignored: Self connection');
      return;
    }

    logInfo('[SwarmManager]', `Peer joined room: ${peerId}`);

    // Sender로서 새 피어에게 연결 시작 (initiator = true)
    this.addPeer(peerId, true);
  }

  private handleOffer(data: SignalingPeerMessage): void {
    // roomId가 설정되지 않았으면 무시
    if (!this.roomId) return;

    const peerId = data.from;
    if (!peerId) return;

    let peer = this.peers.get(peerId);
    if (!peer) {
      // 새 피어 생성 (Receiver로서, initiator = false)
      peer = this.addPeer(peerId, false);
      if (!peer) return; // 슬롯 제한으로 거부됨
    }

    if (data.offer) peer.signal(data.offer);
  }

  private handleAnswer(data: SignalingPeerMessage): void {
    // roomId가 설정되지 않았으면 무시
    if (!this.roomId) return;

    const peerId = data.from;
    const peer = this.peers.get(peerId);
    if (peer && data.answer) {
      peer.signal(data.answer);
    }
  }

  private handleIceCandidate(data: SignalingPeerMessage): void {
    // roomId가 설정되지 않았으면 무시
    if (!this.roomId) return;

    const peerId = data.from;
    const peer = this.peers.get(peerId);
    if (peer && data.candidate) {
      peer.signal(data.candidate);
    }
  }

  private handleUserLeft(data: SignalingPeerMessage): void {
    // roomId가 설정되지 않았으면 무시
    if (!this.roomId) return;

    const peerId = data?.socketId;
    if (peerId) {
      this.removePeer(peerId, 'user-left');
    }
  }

  /**
   * 🚀 [Multi-Receiver] 시그널링 메시지를 특정 피어에게 전달
   * peerId를 target으로 지정하여 해당 피어에게만 메시지 전송
   */
  private forwardSignal(peerId: string, data: OutgoingSignalMessage): void {
    if (!this.roomId) return;

    // 🚀 [핵심] peerId를 target으로 지정하여 특정 피어에게만 전달
    if (data.type === 'offer') {
      signalingService.sendOffer(this.roomId, data, peerId);
    } else if (data.type === 'answer') {
      signalingService.sendAnswer(this.roomId, data, peerId);
    } else if (data.candidate) {
      signalingService.sendCandidate(this.roomId, data, peerId);
    }
  }

  // ======================= 브로드캐스팅 =======================

  /**
   * 🚀 [대기열] 청크를 현재 전송 대상 피어에게만 전송
   */
  public broadcastChunk(chunk: ArrayBuffer): BroadcastResult {
    const failedPeers: string[] = [];
    const sentPeers: string[] = [];
    let successCount = 0;

    // 현재 전송 대상 피어에게만 전송
    for (const peerId of this.currentTransferPeers) {
      const peer = this.peers.get(peerId);
      if (!peer || !peer.connected) {
        failedPeers.push(peerId);
        continue;
      }

      try {
        if (peer.send(chunk)) {
          successCount++;
          sentPeers.push(peerId);
        } else {
          failedPeers.push(peerId);
        }
      } catch (error) {
        logError('[SwarmManager]', `Failed to send to peer ${peerId}:`, error);
        failedPeers.push(peerId);
      }
    }

    return { successCount, failedPeers, sentPeers };
  }

  /**
   * JSON 메시지를 모든 연결된 피어에게 브로드캐스트
   */
  public broadcastMessage(message: object): void {
    const jsonStr = JSON.stringify(message);
    const connectedPeers = this.getConnectedPeers();

    for (const peer of connectedPeers) {
      try {
        peer.send(jsonStr);
      } catch (error) {
        logError(
          '[SwarmManager]',
          `Failed to send message to peer ${peer.id}:`,
          error
        );
      }
    }
  }

  private sendManifestToPeer(peer: SinglePeerConnection): void {
    if (!this.pendingManifest) return;

    try {
      peer.send(
        JSON.stringify({ type: 'MANIFEST', manifest: this.pendingManifest })
      );
      logInfo('[SwarmManager]', `Manifest sent to peer: ${peer.id}`);
    } catch (error) {
      logError(
        '[SwarmManager]',
        `Failed to send manifest to peer ${peer.id}:`,
        error
      );
    }
  }

  // ======================= Backpressure =======================

  /**
   * 모든 피어 중 가장 높은 버퍼 크기 반환
   */
  public getHighestBufferedAmount(): number {
    let highest = 0;
    for (const peer of this.peers.values()) {
      if (peer.connected) {
        const buffered = peer.getBufferedAmount();
        if (buffered > highest) {
          highest = buffered;
        }
      }
    }
    return highest;
  }

  /**
   * 🚀 [Flow Control] 추가 청크 요청 가능 여부
   * 기존: WebRTC 버퍼만 확인
   * 변경: WebRTC 버퍼 + Receiver들의 PAUSE 상태 확인
   */
  public canRequestMoreChunks(): boolean {
    let pausedPeerCount = 0;
    for (const peerId of this.currentTransferPeers) {
      if (this.pausedPeers.has(peerId)) pausedPeerCount++;
    }

    return shouldRequestMoreChunks({
      isProcessingBatch: this.isProcessingBatch,
      isTransferring: this.isTransferring,
      workerReady: this.workerInitialized,
      activePeerCount: this.currentTransferPeers.size,
      highestBufferedAmount: this.getHighestBufferedAmount(),
      highWaterMark: HIGH_WATER_MARK,
      pausedPeerCount,
      pendingAckCount: this.pendingAckPeers.size,
    });
  }

  private isIncompleteDownloadSize(actualSize: number): boolean {
    if (!this.pendingManifest || this.pendingManifest.totalSize <= 0) {
      return false;
    }

    if (this.pendingManifest.isSizeEstimated) {
      return actualSize < this.pendingManifest.totalSize;
    }

    return actualSize !== this.pendingManifest.totalSize;
  }

  private handleResumeRequest(peerId: string, msg: ControlMessage): void {
    const offset = Number(msg.offset);

    if (!Number.isFinite(offset) || offset < 0) {
      logError('[SwarmManager]', `Invalid resume offset from ${peerId}:`, msg);
      return;
    }

    if (!this.canResumeSingleFileTransfer()) {
      logWarn(
        '[SwarmManager]',
        `Resume requested by ${peerId}, but this transfer type is not resumable`
      );
      return;
    }

    const peer = this.peers.get(peerId);
    if (!peer || !peer.connected) {
      logWarn(
        '[SwarmManager]',
        `Resume requested by disconnected peer ${peerId}`
      );
      return;
    }

    logInfo(
      '[SwarmManager]',
      `Resuming transfer for ${peerId} from offset ${offset}`
    );

    this.currentTransferPeers = new Set([peerId]);
    this.completedPeersInSession.delete(peerId);
    this.pausedPeers.delete(peerId);
    this.pendingAckPeers.clear();
    this.partitionAckWaiters.clear();
    this.awaitingReceiverReconnect = false;
    this.isTransferring = false;
    this.isProcessingBatch = false;
    this.totalBytesSent = offset;
    this.transferStartTime = performance.now();

    void this.runPartitionedTransfer(offset);
  }

  private canResumeSingleFileTransfer(): boolean {
    return (
      !!this.worker &&
      !!this.pendingManifest &&
      this.pendingManifest.totalFiles === this.files.length &&
      this.files.length > 0
    );
  }

  private handleDrain(_peerId: string): void {
    this.notifySendWindowWaiters();

    // 글로벌 backpressure 재평가
    if (this.isTransferring && this.canRequestMoreChunks()) {
      this.updateAdaptiveTransferConfig();
      this.requestMoreChunks();
    }
  }

  private getPeerStats(
    peer: SinglePeerConnection
  ): Promise<RTCStatsReport> | null {
    const simplePeer = peer.pc as { _pc?: RTCPeerConnection } | null;

    const nativePeer = simplePeer?._pc;
    if (!nativePeer || typeof nativePeer.getStats !== 'function') {
      return null;
    }

    return nativePeer.getStats();
  }

  private updateAdaptiveTransferConfig(): void {
    if (!this.worker || !this.isTransferring) return;

    networkController.updateBufferState(this.getHighestBufferedAmount());

    const nextConfig = networkController.getAdaptiveParams();
    this.currentBatchSize = nextConfig.batchSize;

    if (
      this.lastAdaptiveConfig &&
      this.lastAdaptiveConfig.batchSize === nextConfig.batchSize &&
      this.lastAdaptiveConfig.chunkSize === nextConfig.chunkSize
    ) {
      return;
    }

    this.lastAdaptiveConfig = nextConfig;
    this.worker.postMessage({
      type: 'update-adaptive-config',
      payload: {
        chunkSize: nextConfig.chunkSize,
        prefetchBatch: nextConfig.batchSize,
        enableAdaptive: true,
      },
    });
  }

  private async sampleAdaptiveStats(): Promise<void> {
    if (!this.isTransferring) return;

    const activePeers = [...this.currentTransferPeers]
      .map(peerId => this.peers.get(peerId))
      .filter((peer): peer is SinglePeerConnection => !!peer && peer.connected);

    const statsRequests = activePeers
      .map(peer => this.getPeerStats(peer))
      .filter((request): request is Promise<RTCStatsReport> => !!request);

    const statsResults = await Promise.allSettled(statsRequests);
    for (const result of statsResults) {
      if (result.status === 'fulfilled') {
        networkController.updateFromWebRTCStats(result.value);
      }
    }

    this.updateAdaptiveTransferConfig();
  }

  private startAdaptiveControl(): void {
    this.stopAdaptiveControl();
    networkController.reset();
    networkController.start();
    this.lastAdaptiveConfig = null;
    this.currentBatchSize = networkController.getAdaptiveParams().batchSize;
    this.updateAdaptiveTransferConfig();

    this.adaptiveStatsInterval = setInterval(() => {
      this.sampleAdaptiveStats().catch(error => {
        logDebug('[SwarmManager]', 'Adaptive stats sample skipped:', error);
      });
    }, 500);
  }

  private stopAdaptiveControl(): void {
    if (this.adaptiveStatsInterval) {
      clearInterval(this.adaptiveStatsInterval);
      this.adaptiveStatsInterval = null;
    }
    this.lastAdaptiveConfig = null;
    networkController.reset();
    this.currentBatchSize = BATCH_SIZE_INITIAL;
  }

  private startTransferPumpWatchdog(): void {
    this.stopTransferPumpWatchdog();
    this.transferPumpInterval = setInterval(() => {
      if (this.canRequestMoreChunks()) {
        this.requestMoreChunks();
      }
    }, 250);
  }

  private stopTransferPumpWatchdog(): void {
    if (this.transferPumpInterval) {
      clearInterval(this.transferPumpInterval);
      this.transferPumpInterval = null;
    }
  }

  private clearWorkerBatchTimeout(): void {
    if (this.workerBatchTimeout) {
      clearTimeout(this.workerBatchTimeout);
      this.workerBatchTimeout = null;
    }
  }

  private armWorkerBatchTimeout(): void {
    this.clearWorkerBatchTimeout();
    this.workerBatchTimeout = setTimeout(() => {
      this.workerBatchTimeout = null;
      this.isProcessingBatch = false;
      logError(
        '[SwarmManager]',
        'Worker did not respond to process-batch within timeout'
      );
      this.emit('transfer-failed', 'File reader stalled before the transfer completed');
      this.cleanup();
    }, 20000);
  }

  // ======================= 데이터 처리 =======================

  private handlePeerData(peerId: string, data: ArrayBuffer | string): void {
    // JSON 메시지 처리
    if (
      typeof data === 'string' ||
      (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 123)
    ) {
      try {
        const str =
          typeof data === 'string' ? data : new TextDecoder().decode(data);
        const msg = JSON.parse(str) as ControlMessage;
        this.handleControlMessage(peerId, msg);
      } catch (e) {
        // JSON 파싱 실패 - 무시
      }
      return;
    }

    // 바이너리 데이터는 Receiver 측에서 처리 (SwarmManager는 Sender 전용)
    this.emit('data', { peerId, data });
  }

  /**
   * 🚀 [핵심] 피어로부터 받은 제어 메시지 처리
   */
  private handleControlMessage(peerId: string, msg: ControlMessage): void {
    const peer = this.peers.get(peerId);

    switch (msg.type) {
      case 'KEEP_ALIVE':
        // Keep-alive 메시지는 무시 (연결 유지 목적)
        return;

      case 'PARTITION_ACK': {
        const offset =
          typeof msg.offset === 'number' ? msg.offset : Number(msg.offset);
        const pending = this.partitionAckWaiters.get(offset);
        if (pending) {
          pending.delete(peerId);
          if (pending.size === 0) {
            this.partitionAckWaiters.delete(offset);
          }
        }
        this.notifySendWindowWaiters();
        return;
      }

      // 🚀 [Flow Control] PAUSE/RESUME 처리
      case 'CONTROL':
        if (msg.action === 'PAUSE') {
          logInfo(
            '[SwarmManager]',
            `Peer ${peerId} requested PAUSE (Disk busy)`
          );
          this.pausedPeers.add(peerId);
        } else if (msg.action === 'RESUME') {
          logInfo('[SwarmManager]', `Peer ${peerId} requested RESUME`);
          this.pausedPeers.delete(peerId);
          this.notifySendWindowWaiters();

          // 모든 피어가 준비되었으면(혹은 내가 보내는 중인 피어들이 풀렸으면) 다시 요청
          if (this.isTransferring && this.canRequestMoreChunks()) {
            logDebug(
              '[SwarmManager]',
              'Resuming transfer loop via explicit request'
            );
            this.requestMoreChunks();
          }
        } else if (msg.action === 'ACK') {
          this.pendingAckPeers.delete(peerId);
          if (this.isTransferring && this.canRequestMoreChunks()) {
            this.requestMoreChunks();
          }
        }
        break;

      case 'TRANSFER_READY':
        if (peer) {
          // 이미 완료된 피어인지 확인
          if (this.completedPeersInSession.has(peerId)) {
            logInfo(
              '[SwarmManager]',
              `Peer ${peerId} already completed, ignoring TRANSFER_READY`
            );
            return;
          }

          if (peer.ready) {
            logInfo(
              '[SwarmManager]',
              `Peer ${peerId} is already ready, ignoring duplicate TRANSFER_READY`
            );
            return;
          }

          peer.ready = true;

          // 🚀 [대기열] 이미 전송 중이면 대기열에 추가
          if (this.isTransferring) {
            if (
              !this.transferQueue.includes(peerId) &&
              !this.currentTransferPeers.has(peerId)
            ) {
              this.transferQueue.push(peerId);
              logInfo(
                '[SwarmManager]',
                `Peer added to queue: ${peerId} (queue size: ${this.transferQueue.length})`
              );

              // 대기 중 알림
              try {
                peer.send(
                  JSON.stringify({
                    type: 'QUEUED',
                    message:
                      'Transfer in progress. You are in queue and will receive the file shortly.',
                    position: this.transferQueue.length,
                  })
                );
              } catch (e) {
                /* ignore */
              }

              this.emit('peer-queued', {
                peerId,
                position: this.transferQueue.length,
              });
            }
            return;
          }

          logInfo('[SwarmManager]', `Peer ready: ${peerId}`);
          this.emit('peer-ready', peerId);

          // 🚀 [핵심] 이전 전송이 완료된 상태에서 새 피어가 ready되면
          // 1:1 상황인지 확인 후 즉시 또는 대기 후 전송
          if (this.completedPeersInSession.size > 0) {
            // 이전 전송 완료 후 새 피어가 ready됨
            const pendingPeers = this.getConnectedPeers().filter(
              p => !this.completedPeersInSession.has(p.id)
            );
            const readyPeers = pendingPeers.filter(p => p.ready);

            // 대기 중인 피어가 이 피어 하나뿐이면 즉시 시작 (1:1 상황)
            if (pendingPeers.length === 1 && readyPeers.length === 1) {
              logInfo(
                '[SwarmManager]',
                `Single waiting peer ready. Starting transfer immediately for ${peerId}`
              );
              this.startTransferWithReadyPeers();
              return;
            }

            // 🚀 [핵심 추가] 여러 피어가 대기 중이면 10초 타이머 시작
            if (
              pendingPeers.length > 1 &&
              readyPeers.length > 0 &&
              !this.readyTimeout
            ) {
              logInfo(
                '[SwarmManager]',
                `Multiple pending peers. Starting ${READY_WAIT_TIME_1N / 1000}s countdown...`
              );
              this.emit('ready-countdown-start', {
                readyCount: readyPeers.length,
                totalCount: pendingPeers.length,
                waitTime: READY_WAIT_TIME_1N,
              });

              this.readyTimeout = setTimeout(() => {
                this.readyTimeout = null;
                if (!this.isTransferring) {
                  const currentReadyPeers = this.getConnectedPeers().filter(
                    p => p.ready && !this.completedPeersInSession.has(p.id)
                  );
                  if (currentReadyPeers.length > 0) {
                    logInfo(
                      '[SwarmManager]',
                      `Timeout reached. Starting with ${currentReadyPeers.length} ready peers...`
                    );
                    this.startTransferWithReadyPeers();
                  }
                }
              }, READY_WAIT_TIME_1N);
              return;
            }
          }

          // 일반적인 ready 체크 로직 실행
          this.checkAllPeersReady();
        }
        break;

      case 'DOWNLOAD_COMPLETE':
        debugLog(
          '[SwarmManager] 📥 Received DOWNLOAD_COMPLETE from peer:',
          peerId,
          msg
        );

        if (
          this.pendingManifest &&
          typeof msg.actualSize === 'number' &&
          this.isIncompleteDownloadSize(msg.actualSize)
        ) {
          logError(
            '[SwarmManager]',
            `Peer ${peerId} reported incomplete download: ${msg.actualSize}/${this.pendingManifest.totalSize}`
          );
          this.removePeer(peerId, 'incomplete-download');
          this.emit(
            'transfer-failed',
            `Receiver saved only ${msg.actualSize} of ${this.pendingManifest.totalSize} bytes`
          );
          return;
        }

        // 🚀 [핵심 수정] 중복 메시지라도 checkTransferComplete를 강제 실행
        // 이유: 첫 메시지 처리 시 타이밍 이슈로 완료 처리가 안 되었을 수 있음
        // 재전송 메커니즘(3회)이 있으므로 후속 메시지가 상태를 정상화할 기회를 줘야 함
        if (this.completedPeersInSession.has(peerId)) {
          debugLog(
            '[SwarmManager] ⚠️ Duplicate DOWNLOAD_COMPLETE from peer:',
            peerId,
            '- Re-checking completion status anyway'
          );
          // return 제거: 강제로 checkTransferComplete 실행
          this.checkTransferComplete();
          return;
        }

        debugLog('[SwarmManager] 📊 State before processing:', {
          completedPeerCount: this.completedPeerCount,
          completedPeersInSession: [...this.completedPeersInSession],
          currentTransferPeers: [...this.currentTransferPeers],
          isTransferring: this.isTransferring,
        });

        logInfo('[SwarmManager]', `Peer completed download: ${peerId}`);
        this.completedPeerCount++;
        this.completedPeersInSession.add(peerId);
        this.currentTransferPeers.delete(peerId);

        // 🚀 [핵심] 완료된 피어의 ready 상태 리셋 (재다운로드 방지)
        if (peer) {
          peer.ready = false;
        }

        debugLog('[SwarmManager] 📊 State after processing:', {
          completedPeerCount: this.completedPeerCount,
          completedPeersInSession: [...this.completedPeersInSession],
          currentTransferPeers: [...this.currentTransferPeers],
          isTransferring: this.isTransferring,
        });

        this.emit('peer-complete', peerId);
        if (this.canCompleteCurrentSession()) {
          this.emitAllTransfersComplete();
          return;
        }
        debugLog('[SwarmManager] 🔄 Calling checkTransferComplete...');
        this.checkTransferComplete();
        break;

      case 'RESUME_REQUEST':
        this.handleResumeRequest(peerId, msg);
        break;

      default:
        this.emit('message', { peerId, message: msg });
    }
  }

  // 🚀 [Multi-Receiver] Ready 타이머 관련
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;
  private completedPeerCount = 0;

  /**
   * 🚀 [핵심 로직] 피어 Ready 상태 체크 및 전송 시작 결정
   *
   * 1:1 상황: 즉시 전송 시작
   * 1:N 상황: 10초 대기 후 ready된 피어들에게 동시 전송
   */
  private checkAllPeersReady(): void {
    const connectedPeers = this.getConnectedPeers();

    // 이미 완료된 피어는 제외하고 계산
    const pendingPeers = connectedPeers.filter(
      p => !this.completedPeersInSession.has(p.id)
    );
    const readyPeers = pendingPeers.filter(p => p.ready);
    const notReadyPeers = pendingPeers.filter(p => !p.ready);

    logInfo(
      '[SwarmManager]',
      `checkAllPeersReady: connected=${connectedPeers.length}, pending=${pendingPeers.length}, ready=${readyPeers.length}, notReady=${notReadyPeers.length}`
    );

    // 전송 중이면 무시 (대기열 로직에서 처리)
    if (this.isTransferring) {
      logInfo('[SwarmManager]', 'Transfer in progress, skipping ready check');
      return;
    }

    // ready 피어가 없으면 대기
    if (readyPeers.length === 0) {
      return;
    }

    // 🚀 [핵심] 1:1 상황 판단: 연결된 피어가 1명이고 그 피어가 ready
    const is1to1 = connectedPeers.length === 1 && readyPeers.length === 1;

    if (is1to1) {
      // 1:1 상황: 즉시 전송 시작
      this.clearReadyTimeout();
      logInfo(
        '[SwarmManager]',
        '1:1 situation detected. Starting transfer immediately...'
      );
      this.emit('all-peers-ready');
      this.startTransferWithReadyPeers();
      return;
    }

    // 🚀 [핵심] 1:N 상황: 모든 대기 중인 피어가 ready면 즉시 시작
    const allPendingReady =
      pendingPeers.length > 0 && pendingPeers.every(p => p.ready);
    if (allPendingReady) {
      this.clearReadyTimeout();
      logInfo(
        '[SwarmManager]',
        `All ${readyPeers.length} pending peers ready. Starting transfer immediately...`
      );
      this.emit('all-peers-ready');
      this.startTransferWithReadyPeers();
      return;
    }

    // 🚀 [핵심] 1:N 상황: 첫 번째 ready 피어가 나타나면 10초 타이머 시작
    if (readyPeers.length > 0 && !this.readyTimeout) {
      logInfo(
        '[SwarmManager]',
        `1:N situation. First peer ready. Starting ${READY_WAIT_TIME_1N / 1000}s countdown...`
      );
      this.emit('ready-countdown-start', {
        readyCount: readyPeers.length,
        totalCount: pendingPeers.length,
        waitTime: READY_WAIT_TIME_1N,
      });

      this.readyTimeout = setTimeout(() => {
        this.readyTimeout = null;

        // 타임아웃 시점에 다시 상태 확인
        const currentPendingPeers = this.getConnectedPeers().filter(
          p => !this.completedPeersInSession.has(p.id)
        );
        const currentReadyPeers = currentPendingPeers.filter(p => p.ready);

        if (currentReadyPeers.length > 0 && !this.isTransferring) {
          logInfo(
            '[SwarmManager]',
            `Timeout reached. Starting with ${currentReadyPeers.length} ready peers...`
          );
          this.startTransferWithReadyPeers();
        }
      }, READY_WAIT_TIME_1N);
    }

    // 진행 상황 업데이트
    this.emit('ready-status', {
      readyCount: readyPeers.length,
      totalCount: pendingPeers.length,
    });
  }

  private clearReadyTimeout(): void {
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
  }

  /**
   * 🚀 [Multi-Receiver] Ready된 피어만으로 전송 시작
   * Not-ready 피어는 연결 유지하되 전송에서 제외
   */
  private startTransferWithReadyPeers(): void {
    // 이미 전송 중이면 무시
    if (this.isTransferring) {
      logInfo(
        '[SwarmManager]',
        'Transfer already in progress, skipping startTransferWithReadyPeers'
      );
      return;
    }

    const connectedPeers = this.getConnectedPeers();
    const readyPeers = connectedPeers.filter(
      p => p.ready && !this.completedPeersInSession.has(p.id)
    );

    // Not-ready 피어들에게 전송 시작 알림 (연결은 유지)
    const notReadyPeers = connectedPeers.filter(
      p => !p.ready && !this.completedPeersInSession.has(p.id)
    );
    for (const peer of notReadyPeers) {
      try {
        peer.send(
          JSON.stringify({
            type: 'TRANSFER_STARTED_WITHOUT_YOU',
            message:
              'Transfer started with other receivers. You can start download when current transfer completes.',
          })
        );
      } catch (e) {
        /* ignore */
      }
    }

    if (readyPeers.length > 0) {
      // 현재 전송 대상 피어 기록
      this.currentTransferPeers = new Set(readyPeers.map(p => p.id));

      logInfo(
        '[SwarmManager]',
        `🚀 Starting transfer to ${readyPeers.length} peer(s): ${[...this.currentTransferPeers].join(', ')}`
      );
      this.emit('transfer-batch-start', { peerCount: readyPeers.length });
      this.startTransfer();
    } else {
      logError('[SwarmManager]', 'No ready peers to start transfer');
      this.emit('transfer-failed', 'No receivers ready');
    }
  }

  /**
   * 🚀 [대기열] 현재 전송 완료 체크 및 대기열 처리
   *
   * 전송 완료 후:
   * 1. 대기열에 피어가 있으면 즉시 다음 전송 시작
   * 2. 대기 중인 피어(연결됐지만 아직 Start Download 안 누름)가 있으면 대기
   * 3. 모든 피어가 완료되면 Transfer Success UI 표시
   */
  private checkTransferComplete(): void {
    debugLog('[SwarmManager] 🔍 checkTransferComplete called');
    debugLog('[SwarmManager] 📊 Current state:', {
      currentTransferPeers: [...this.currentTransferPeers],
      currentTransferPeersSize: this.currentTransferPeers.size,
      isTransferring: this.isTransferring,
      completedPeersInSession: [...this.completedPeersInSession],
      completedPeersSize: this.completedPeersInSession.size,
      connectedPeersCount: this.getConnectedPeers().length,
    });

    logInfo(
      '[SwarmManager]',
      `checkTransferComplete: currentTransferPeers=${this.currentTransferPeers.size}, isTransferring=${this.isTransferring}, completedPeers=${this.completedPeersInSession.size}`
    );

    // 🚀 [핵심 수정] 현재 전송 대상 피어가 모두 완료되었는지 확인
    // isTransferring이 false여도 currentTransferPeers가 비어있으면 완료 체크 진행
    if (this.currentTransferPeers.size > 0) {
      // 아직 전송 중인 피어가 있음
      debugLog('[SwarmManager] ⏳ Still waiting for peers:', [
        ...this.currentTransferPeers,
      ]);
      logInfo(
        '[SwarmManager]',
        `Still waiting for ${this.currentTransferPeers.size} peer(s) to complete`
      );
      return;
    }

    // 완료된 피어가 없으면 무시
    if (this.completedPeersInSession.size === 0) {
      debugLog('[SwarmManager] ⚠️ No completed peers yet, skipping');
      return;
    }

    debugLog('[SwarmManager] ✅ Current transfer batch complete!');
    logInfo('[SwarmManager]', 'Current transfer batch complete');
    this.isTransferring = false;

    // 1. 대기열에 피어가 있으면 즉시 다음 전송 시작
    debugLog(
      '[SwarmManager] 🔍 Step 1: Checking queue, size:',
      this.transferQueue.length
    );
    if (this.transferQueue.length > 0) {
      logInfo(
        '[SwarmManager]',
        `Queue has ${this.transferQueue.length} peers. Starting next transfer immediately...`
      );
      this.emit('preparing-next-transfer', {
        queueSize: this.transferQueue.length,
      });

      // 약간의 딜레이 후 대기열 처리 (UI 업데이트 시간 확보)
      setTimeout(() => this.processQueue(), 100);
      return;
    }

    // 2. 대기 중인 피어가 있는지 확인 (연결되어 있지만 아직 ready하지 않은 피어)
    const waitingPeers = this.getConnectedPeers().filter(
      p => !p.ready && !this.completedPeersInSession.has(p.id)
    );
    debugLog(
      '[SwarmManager] 🔍 Step 2: Waiting peers (not ready):',
      waitingPeers.length
    );

    // 3. 이미 ready 상태지만 아직 전송 안 받은 피어 확인
    const readyButNotTransferred = this.getConnectedPeers().filter(
      p => p.ready && !this.completedPeersInSession.has(p.id)
    );
    debugLog(
      '[SwarmManager] 🔍 Step 3: Ready but not transferred:',
      readyButNotTransferred.length
    );

    if (readyButNotTransferred.length > 0) {
      // ready 상태인 피어가 있으면 즉시 전송 시작
      debugLog('[SwarmManager] 🚀 Starting transfer for ready peers');
      logInfo(
        '[SwarmManager]',
        `${readyButNotTransferred.length} ready peers waiting. Starting transfer...`
      );
      this.startTransferWithReadyPeers();
      return;
    }

    if (waitingPeers.length > 0) {
      debugLog('[SwarmManager] ⏳ Emitting ready-for-next');
      logInfo(
        '[SwarmManager]',
        `${waitingPeers.length} peers still waiting (not ready yet). Ready for next transfer.`
      );

      // 대기 중인 피어들에게 다운로드 가능 알림
      for (const peer of waitingPeers) {
        try {
          peer.send(
            JSON.stringify({
              type: 'READY_FOR_DOWNLOAD',
              message:
                'Previous transfer completed. You can now start your download.',
            })
          );
        } catch (e) {
          /* ignore */
        }
      }

      this.emit('ready-for-next', {
        waitingCount: waitingPeers.length,
        completedCount: this.completedPeersInSession.size,
      });
      return;
    }

    // 4. 모든 연결된 피어가 완료됨 - Transfer Success!
    const connectedPeers = this.getConnectedPeers();
    debugLog('[SwarmManager] 🔍 Step 4: Final check');
    debugLog('[SwarmManager] 📊 Connected peers:', connectedPeers.length);
    debugLog(
      '[SwarmManager] 📊 Completed peers:',
      this.completedPeersInSession.size
    );

    const allConnectedCompleted =
      connectedPeers.length > 0 &&
      connectedPeers.every(p => this.completedPeersInSession.has(p.id));

    debugLog(
      '[SwarmManager] 📊 All connected completed?',
      allConnectedCompleted
    );
    debugLog(
      '[SwarmManager] 📊 No connected but has completed?',
      connectedPeers.length === 0 && this.completedPeersInSession.size > 0
    );

    if (
      allConnectedCompleted ||
      (connectedPeers.length === 0 && this.completedPeersInSession.size > 0)
    ) {
      this.emitAllTransfersComplete();
    } else {
      debugLog('[SwarmManager] 📦 Emitting batch-complete');
      logInfo(
        '[SwarmManager]',
        'Transfer batch complete. Waiting for more receivers.'
      );
      this.emit('batch-complete', {
        completedCount: this.completedPeersInSession.size,
      });
    }
  }

  private canCompleteCurrentSession(): boolean {
    if (this.completedPeersInSession.size === 0) return false;
    if (this.currentTransferPeers.size > 0) return false;
    if (this.transferQueue.length > 0) return false;

    return this.getConnectedPeers().every(peer =>
      this.completedPeersInSession.has(peer.id)
    );
  }

  public isSessionComplete(): boolean {
    return this.allTransfersCompleteEmitted || this.canCompleteCurrentSession();
  }

  private emitAllTransfersComplete(): void {
    if (this.allTransfersCompleteEmitted) return;

    this.allTransfersCompleteEmitted = true;
    this.isTransferring = false;

    debugLog('[SwarmManager] 🎉 Emitting all-transfers-complete!');
    logInfo(
      '[SwarmManager]',
      `🎉 All transfers complete! ${this.completedPeersInSession.size} receivers finished.`
    );

    this.emit('all-transfers-complete');
    this.emit('complete');

    setTimeout(() => {
      debugLog(
        '[SwarmManager] ✅ Transfer session completed, ready for cleanup'
      );
    }, 1000);
  }

  /**
   * 🚀 [대기열] 대기열 처리 - 다음 전송 시작
   * 대기열에 있는 피어들에게 즉시 전송 시작
   */
  private processQueue(): void {
    if (this.transferQueue.length === 0 || this.isTransferring) {
      logInfo(
        '[SwarmManager]',
        `processQueue skipped: queue=${this.transferQueue.length}, transferring=${this.isTransferring}`
      );
      return;
    }

    // 대기열의 피어들을 현재 전송 대상으로 설정
    const queuedPeerIds = [...this.transferQueue];
    this.transferQueue = [];

    // 유효한 피어만 필터링 (연결되어 있고 ready 상태인 피어)
    const validPeers: SinglePeerConnection[] = [];
    for (const peerId of queuedPeerIds) {
      const peer = this.peers.get(peerId);
      if (
        peer &&
        peer.connected &&
        peer.ready &&
        !this.completedPeersInSession.has(peerId)
      ) {
        validPeers.push(peer);
      } else {
        logInfo(
          '[SwarmManager]',
          `Queued peer ${peerId} is no longer valid (connected=${peer?.connected}, ready=${peer?.ready})`
        );
      }
    }

    if (validPeers.length > 0) {
      this.currentTransferPeers = new Set(validPeers.map(p => p.id));

      // 🚀 [핵심] 대기열 피어들에게 전송 시작 알림 (TRANSFER_STARTING)
      // ReceiverView에서 이 메시지를 받으면 QUEUED -> RECEIVING 상태로 전환
      for (const peer of validPeers) {
        try {
          peer.send(JSON.stringify({ type: 'TRANSFER_STARTING' }));
        } catch (e) {
          /* ignore */
        }
      }

      logInfo(
        '[SwarmManager]',
        `🚀 Starting queued transfer to ${validPeers.length} peer(s): ${[...this.currentTransferPeers].join(', ')}`
      );
      this.emit('transfer-batch-start', {
        peerCount: validPeers.length,
        fromQueue: true,
      });

      // 🚀 [핵심] 대기열 초기화 이벤트 발생 (SenderView UI 업데이트용)
      this.emit('queue-cleared', { processedCount: validPeers.length });

      this.startTransfer();
    } else {
      logInfo(
        '[SwarmManager]',
        'No valid peers in queue, checking for other ready peers...'
      );
      // 대기열이 비었지만 다른 ready 피어가 있을 수 있음
      this.checkTransferComplete();
    }
  }

  // ======================= 전송 제어 =======================

  /**
   * Sender 초기화
   */
  public async initSender(
    manifest: TransferManifest,
    files: File[],
    roomId: string
  ): Promise<void> {
    logInfo('[SwarmManager]', 'Initializing sender...');
    this.resetState();

    this.roomId = roomId;
    this.pendingManifest = manifest;
    this.files = files; // 🚀 [대기열] 파일 저장 (재전송용)
    this.totalBytes = manifest.totalSize;
    this.totalBytesSent = 0;
    this.completedPeerCount = 0;
    this.allTransfersCompleteEmitted = false;
    this.ensureTransferEncryption();

    // TURN 설정 가져오기
    await this.fetchTurnConfig(roomId);

    // 시그널링 연결
    await signalingService.connect();
    await signalingService.joinRoom(roomId);

    this.emit('status', 'WAITING_FOR_PEER');
  }

  private setupWorkerHandlers(files: File[], manifest: TransferManifest): void {
    if (!this.worker) return;

    let workerStarted = false;
    const startWorkerInitialization = () => {
      if (!this.worker || workerStarted) return;
      workerStarted = true;

      // 🔐 암호화 키 설정 (활성화된 경우)
      if (this.isEncryptionEnabled() && this.sessionKey && this.randomPrefix) {
        debugLog('[SwarmManager] 🔐 Setting encryption key on worker');
        this.worker.postMessage({
          type: 'set-encryption-key',
          payload: {
            sessionKey: this.sessionKey,
            randomPrefix: this.randomPrefix,
          },
        });
      }

      this.worker.postMessage({
        type: 'init',
        payload: { files, manifest },
      });
    };

    this.worker.onmessage = e => {
      const { type, payload } = e.data;

      switch (type) {
        case 'ready':
          debugLog(
            '[SwarmManager] ✅ [DEBUG] Worker ready, initializing with',
            files.length,
            'files'
          );

          startWorkerInitialization();
          break;

        case 'encryption-ready':
          debugLog('[SwarmManager] 🔐 Worker encryption ready');
          break;

        case 'encryption-error':
          console.error('[SwarmManager] 🔐 Worker encryption error:', payload);
          this.emit('encryption-error', payload);
          break;

        case 'init-complete':
          debugLog(
            '[SwarmManager] ✅ [DEBUG] Worker initialization complete. Is transferring:',
            this.isTransferring,
            'Pending start:',
            this.pendingTransferStart
          );
          this.workerInitialized = true;

          if (this.pendingWorkerResumeOffset !== null) {
            const offset = this.pendingWorkerResumeOffset;
            this.pendingWorkerResumeOffset = null;
            this.awaitingWorkerResume = true;
            this.worker.postMessage({
              type: 'resume-single-file',
              payload: { offset },
            });
            return;
          }

          // 🚀 [핵심 수정] 전송 대기 중이면 즉시 첫 배치 요청
          if (this.pendingTransferStart && this.isTransferring) {
            this.pendingTransferStart = false;
            logInfo(
              '[SwarmManager]',
              'Worker init complete, requesting first batch...'
            );
            this.requestMoreChunks();
          }
          break;

        case 'error':
          this.clearWorkerBatchTimeout();
          console.error('[SwarmManager] ❌ [DEBUG] Worker error:', payload);
          this.emit('error', payload.message || 'Worker error occurred');
          this.cleanup();
          break;

        case 'chunk-batch':
          debugLog(
            '[SwarmManager] 📦 [DEBUG] Chunk batch received from worker:',
            {
              chunkCount: payload.chunks?.length || 0,
              progress: payload.progressData?.progress || 0,
              bytesTransferred: payload.progressData?.bytesTransferred || 0,
              totalBytes: payload.progressData?.totalBytes || 0,
            }
          );
          this.handleBatchFromWorker(payload);
          break;

        case 'resume-ready':
          this.clearWorkerBatchTimeout();
          logInfo(
            '[SwarmManager]',
            `Worker resume ready from offset ${payload?.offset ?? 0}`
          );
          this.awaitingWorkerResume = false;
          this.workerInitialized = true;
          this.isProcessingBatch = false;
          this.requestMoreChunks();
          break;

        case 'complete':
          this.clearWorkerBatchTimeout();
          debugLog(
            '[SwarmManager] ✅ [DEBUG] Worker reported transfer complete'
          );
          this.finishTransfer();
          break;

        default:
          debugLog(
            '[SwarmManager] ❓ [DEBUG] Unknown worker message type:',
            type
          );
      }
    };

    this.worker.onerror = error => {
      this.clearWorkerBatchTimeout();
      console.error('[SwarmManager] ❌ [DEBUG] Worker fatal error:', error);
      this.emit(
        'error',
        'Worker crashed: ' + (error.message || 'Unknown error')
      );
      this.cleanup();
    };

    // Worker가 캐시/WASM 초기화 타이밍 때문에 ready 이벤트를 놓쳐도 init은
    // worker 내부에서 WASM 준비를 기다릴 수 있으므로 직접 시작한다.
    setTimeout(startWorkerInitialization, 0);
  }

  private handleBatchFromWorker(payload: WorkerBatchPayload): void {
    const connectedPeers = this.getConnectedPeers();
    if (connectedPeers.length === 0) {
      logError(
        '[SwarmManager]',
        '❌ [DEBUG] No connected peers, dropping batch'
      );
      return;
    }

    const { chunks, progressData } = payload;
    this.clearWorkerBatchTimeout();
    this.isProcessingBatch = false;

    debugLog('[SwarmManager] 📊 [DEBUG] Processing batch from worker:', {
      chunkCount: chunks.length,
      totalBatchSize: chunks.reduce(
        (sum: number, chunk: ArrayBuffer) => sum + chunk.byteLength,
        0
      ),
      connectedPeers: connectedPeers.length,
      currentTransferPeers: this.currentTransferPeers.size,
      isTransferring: this.isTransferring,
      progress: progressData?.progress || 0,
    });

    try {
      // 모든 피어에게 브로드캐스트
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        debugLog(
          '[SwarmManager] 📤 [DEBUG] Broadcasting chunk',
          i + 1,
          '/',
          chunks.length,
          'Size:',
          chunk.byteLength
        );

        const result = this.broadcastChunk(chunk);
        if (result.successCount > 0) {
          this.pendingAckPeers = new Set(result.sentPeers);
        }
        networkController.recordSend(chunk.byteLength);
        this.totalBytesSent += getPacketPayloadSize(chunk);

        debugLog('[SwarmManager] 📊 [DEBUG] Chunk broadcast result:', {
          successCount: result.successCount,
          failedPeers: result.failedPeers.length,
          totalBytesSent: this.totalBytesSent,
        });

        // 실패한 피어 제거
        for (const failedPeerId of result.failedPeers) {
          debugLog(
            '[SwarmManager] ❌ [DEBUG] Removing failed peer:',
            failedPeerId
          );
          this.removePeer(failedPeerId, 'send-failed');
        }
      }

      // 진행률 방출
      this.emitProgress(progressData);
      this.updateAdaptiveTransferConfig();

      // Backpressure 체크 후 다음 배치 요청
      const canRequestMore = this.canRequestMoreChunks();
      debugLog('[SwarmManager] 🔄 [DEBUG] Backpressure check:', {
        canRequestMore,
        highestBufferedAmount: this.getHighestBufferedAmount(),
        highWaterMark: HIGH_WATER_MARK,
      });

      if (canRequestMore) {
        debugLog('[SwarmManager] ➡️ [DEBUG] Requesting more chunks');
        this.requestMoreChunks();
      } else {
        debugLog(
          '[SwarmManager] ⏸️ [DEBUG] Buffer full, pausing chunk requests'
        );
      }
    } catch (error) {
      console.error(
        '[SwarmManager]',
        '❌ [DEBUG] Batch processing failed:',
        error
      );
      debugLog('[SwarmManager] 📊 [DEBUG] State at error:', {
        connectedPeers: connectedPeers.length,
        currentTransferPeers: this.currentTransferPeers.size,
        isProcessingBatch: this.isProcessingBatch,
        totalBytesSent: this.totalBytesSent,
      });
      this.cleanup();
    }
  }

  // Worker 초기화 완료 대기용 플래그
  private workerInitialized = false;
  private pendingTransferStart = false;
  private awaitingWorkerResume = false;
  private pendingWorkerResumeOffset: number | null = null;

  private startTransfer(): void {
    if (this.isTransferring) return;
    void this.runPartitionedTransfer(0);
  }

  private async runPartitionedTransfer(startOffset = 0): Promise<void> {
    if (!this.pendingManifest) return;

    this.isTransferring = true;
    this.awaitingReceiverReconnect = false;
    this.isProcessingBatch = false;
    this.totalBytesSent = startOffset;
    this.pendingAckPeers.clear();
    this.partitionAckWaiters.clear();
    this.transferStartTime = performance.now();
    this.workerInitialized = false;
    this.awaitingWorkerResume = false;
    this.pendingWorkerResumeOffset = null;
    this.pendingTransferStart = false;
    this.stopTransferPumpWatchdog();
    this.stopAdaptiveControl();

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    const manifest = this.pendingManifest;

    // PairDrop/Snapdrop-style pull window: ordered binary chunks, then one
    // partition marker, then wait until receivers ACK that partition before
    // sending more. This replaces the worker push pump that could outrun real
    // browser receiver/write queues and stall at a stable progress percentage.
    for (const peerId of Array.from(this.currentTransferPeers)) {
      const peer = this.peers.get(peerId);
      if (peer && peer.connected) {
        try {
          peer.send(JSON.stringify({ type: 'MANIFEST', manifest }));
          peer.send(JSON.stringify({ type: 'TRANSFER_STARTED' }));
        } catch (e) {
          this.removePeer(peerId, 'transfer-start-send-failed');
        }
      }
    }

    this.emit('progress', {
      progress: 0,
      totalBytesSent: 0,
      totalBytes: this.totalBytes,
      speed: 0,
      peers: this.getPeerStates(),
    });
    this.emit('status', 'TRANSFERRING');

    try {
      await this.sendFilesPartitioned(manifest, startOffset);
      await this.finishTransfer();
    } catch (error) {
      if (this.awaitingReceiverReconnect) {
        logWarn(
          '[SwarmManager]',
          'Partitioned transfer paused while waiting for receiver reconnect'
        );
        return;
      }
      logError('[SwarmManager]', 'Partitioned transfer failed:', error);
      this.isTransferring = false;
      this.emit(
        'transfer-failed',
        error instanceof Error ? error.message : 'Transfer failed'
      );
    }
  }

  private async sendFilesPartitioned(
    manifest: TransferManifest,
    startOffset = 0
  ): Promise<void> {
    const partitionSize = TRANSFER_PARTITION_SIZE;
    const cursor = getPartitionedResumeCursor({
      fileSizes: this.files.map(file => file.size),
      startOffset,
      chunkSize: CHUNK_SIZE_INITIAL,
      partitionSize,
      totalSize: manifest.totalSize,
    });
    let sequence = cursor.sequence;
    let globalOffset = cursor.globalOffset;
    let partitionEnd = cursor.nextPartitionEnd;

    for (let fileIndex = cursor.fileIndex; fileIndex < this.files.length; fileIndex++) {
      const file = this.files[fileIndex];
      let fileOffset = fileIndex === cursor.fileIndex ? cursor.fileOffset : 0;
      while (fileOffset < file.size) {
        if (!this.isTransferring) {
          throw new Error('Transfer stopped');
        }

        await this.waitUntilSendWindowOpen();

        const chunkEnd = Math.min(fileOffset + CHUNK_SIZE_INITIAL, file.size);
        const payload = await file.slice(fileOffset, chunkEnd).arrayBuffer();
        const packet = createPlainDataPacket({
          payload,
          sequence: sequence++,
          offset: globalOffset,
        });

        const result = this.broadcastChunk(packet);
        for (const failedPeerId of result.failedPeers) {
          this.removePeer(failedPeerId, 'partitioned-send-failed');
        }
        if (result.successCount === 0) {
          throw new Error('No connected receivers available');
        }

        const payloadBytes = payload.byteLength;
        fileOffset += payloadBytes;
        globalOffset += payloadBytes;
        this.totalBytesSent = globalOffset;
        networkController.recordSend(packet.byteLength);
        this.emitProgress();

        if (globalOffset >= partitionEnd && globalOffset < manifest.totalSize) {
          await this.sendPartitionMarkerAndWait(globalOffset);
          partitionEnd = Math.min(partitionEnd + partitionSize, manifest.totalSize);
        }
      }
    }

    if (globalOffset !== manifest.totalSize) {
      throw new Error(
        `Transfer size mismatch: sent ${globalOffset}, expected ${manifest.totalSize}`
      );
    }

    await this.sendPartitionMarkerAndWait(globalOffset);
  }

  private async waitUntilSendWindowOpen(): Promise<void> {
    const started = performance.now();
    while (this.isTransferring) {
      const activePeerIds = this.getActiveTransferPeerIds();
      if (activePeerIds.length === 0) {
        throw new Error('No active receivers');
      }

      const hasPausedPeer = activePeerIds.some(peerId =>
        this.pausedPeers.has(peerId)
      );
      if (!hasPausedPeer && this.getHighestBufferedAmount() < HIGH_WATER_MARK) {
        return;
      }

      if (performance.now() - started > 120_000) {
        throw new Error('Timed out waiting for receiver/backpressure window');
      }
      await this.waitForSendWindowSignal(SEND_WINDOW_POLL_INTERVAL_MS);
    }
    throw new Error('Transfer stopped');
  }

  private async sendPartitionMarkerAndWait(offset: number): Promise<void> {
    const peerIds = this.getActiveTransferPeerIds();
    if (peerIds.length === 0) {
      throw new Error('No active receivers for partition ACK');
    }

    this.partitionAckWaiters.set(offset, new Set(peerIds));
    const msg = JSON.stringify({ type: 'PARTITION', offset });
    for (const peerId of peerIds) {
      const peer = this.peers.get(peerId);
      if (peer && peer.connected) {
        peer.send(msg);
      }
    }

    const started = performance.now();
    while (this.isTransferring) {
      const pending = this.partitionAckWaiters.get(offset);
      if (!pending || pending.size === 0) {
        this.partitionAckWaiters.delete(offset);
        return;
      }

      for (const peerId of Array.from(pending)) {
        const peer = this.peers.get(peerId);
        if (!peer || !peer.connected || !this.currentTransferPeers.has(peerId)) {
          pending.delete(peerId);
        }
      }

      if (pending.size === 0) {
        this.partitionAckWaiters.delete(offset);
        return;
      }

      if (performance.now() - started > 120_000) {
        throw new Error(`Timed out waiting for partition ACK at ${offset}`);
      }
      await this.waitForSendWindowSignal(PARTITION_ACK_POLL_INTERVAL_MS);
    }
    throw new Error('Transfer stopped');
  }

  private getActiveTransferPeerIds(): string[] {
    return Array.from(this.currentTransferPeers).filter(peerId => {
      const peer = this.peers.get(peerId);
      return !!peer && peer.connected;
    });
  }

  private waitForSendWindowSignal(timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timeout);
        this.sendWindowWaiters.delete(done);
        resolve();
      };

      const timeout = setTimeout(done, timeoutMs);
      this.sendWindowWaiters.add(done);
    });
  }

  private notifySendWindowWaiters(): void {
    const waiters = Array.from(this.sendWindowWaiters);
    this.sendWindowWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  private requestMoreChunks(): void {
    if (this.isProcessingBatch || !this.worker || !this.isTransferring) return;

    // 🚨 [FIX] Worker 초기화 완료 체크 (Race Condition 방지)
    if (!this.workerInitialized) {
      debugLog(
        '[SwarmManager] ⏳ Worker not fully initialized yet, skipping request (will retry on init-complete)'
      );
      return;
    }

    this.isProcessingBatch = true;
    this.updateAdaptiveTransferConfig();
    const safeBatchSize = calculateSafeBatchRequestSize({
      desiredBatchSize: this.currentBatchSize,
      highestBufferedAmount: this.getHighestBufferedAmount(),
      highWaterMark: HIGH_WATER_MARK,
      chunkPayloadSize: this.lastAdaptiveConfig?.chunkSize ?? 64 * 1024,
      packetOverheadBytes: HEADER_SIZE + 48,
      minBatchSize: 1,
    });

    if (safeBatchSize <= 0) {
      this.isProcessingBatch = false;
      return;
    }

    this.armWorkerBatchTimeout();
    this.worker.postMessage({
      type: 'process-batch',
      payload: { count: safeBatchSize },
    });
  }

  private async finishTransfer(): Promise<void> {
    if (this.awaitingWorkerResume) {
      logInfo('[SwarmManager]', 'Ignoring worker complete while resume is pending');
      return;
    }

    this.clearWorkerBatchTimeout();
    if (
      isPrematureTransferComplete({
        sentBytes: this.totalBytesSent,
        expectedBytes: this.totalBytes,
        packetOverheadAllowance: this.currentBatchSize * (HEADER_SIZE + 16),
      })
    ) {
      logError('[SwarmManager]', 'Worker completed before all payload bytes were queued', {
        totalBytesSent: this.totalBytesSent,
        totalBytes: this.totalBytes,
      });
      this.awaitingWorkerResume = true;
      this.pendingWorkerResumeOffset = this.totalBytesSent;
      this.isProcessingBatch = false;
      this.workerInitialized = false;
      this.worker?.terminate();
      this.worker = getSenderWorkerV1();
      this.setupWorkerHandlers(this.files, this.pendingManifest!);
      return;
    }

    this.isTransferring = false;
    this.stopTransferPumpWatchdog();
    this.stopAdaptiveControl();

    // 버퍼가 비워질 때까지 대기
    await this.waitForBufferZero();
    await new Promise(resolve => setTimeout(resolve, 500));

    // EOS 패킷 브로드캐스트
    const eosPacket = createEosPacket();

    const result = this.broadcastChunk(eosPacket);
    for (const failedPeerId of result.failedPeers) {
      this.removePeer(failedPeerId, 'eos-send-failed');
    }

    if (result.successCount === 0) {
      this.emit('transfer-failed', 'Failed to send transfer completion signal');
      return;
    }

    logInfo('[SwarmManager]', 'EOS broadcast complete');

    this.emit('remote-processing', true);
  }

  private waitForBufferZero(): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        if (this.getHighestBufferedAmount() === 0) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  private emitProgress(progressData: WorkerProgressData = {}): void {
    const elapsed = (performance.now() - this.transferStartTime) / 1000;
    const speed = elapsed > 0 ? this.totalBytesSent / elapsed : 0;
    const transportProgress = calculateProgressPercent(
      this.totalBytesSent,
      this.totalBytes
    );

    this.emit('progress', {
      ...progressData,
      progress: transportProgress,
      overallProgress: transportProgress,
      bytesTransferred: Math.min(this.totalBytesSent, this.totalBytes),
      totalBytesSent: this.totalBytesSent,
      totalBytes: this.totalBytes,
      speed,
      peers: this.getPeerStates(),
    });
  }

  // ======================= 상태 조회 =======================

  /**
   * Swarm 상태 조회
   */
  public getState(): SwarmState {
    return {
      roomId: this.roomId,
      peerCount: this.peers.size,
      connectedCount: this.getConnectedPeers().length,
      readyCount: this.getReadyPeerCount(),
      isTransferring: this.isTransferring,
      highestBufferedAmount: this.getHighestBufferedAmount(),
    };
  }

  /**
   * 모든 피어 상태 조회
   */
  public getPeerStates(): PeerState[] {
    return Array.from(this.peers.values()).map(p => p.getState());
  }

  // ======================= 유틸리티 =======================

  private async fetchTurnConfig(roomId: string): Promise<void> {
    try {
      const response = await signalingService.requestTurnConfig(roomId);
      if (response?.success && response?.data) {
        this.iceServers = response.data.iceServers;
      }
    } catch (error) {
      logError('[SwarmManager]', 'Failed to fetch TURN config:', error);
    }
  }

  /**
   * Keep-alive 시작 (연결 유지용)
   */
  private startKeepAlive(): void {
    if (this.keepAliveInterval) return;

    this.keepAliveInterval = setInterval(() => {
      const connectedPeers = this.getConnectedPeers();
      if (connectedPeers.length === 0) {
        this.stopKeepAlive();
        return;
      }

      // 전송 중이 아닐 때만 keep-alive 전송 (전송 중에는 데이터가 계속 흐름)
      if (!this.isTransferring) {
        for (const peer of connectedPeers) {
          try {
            peer.send(JSON.stringify({ type: 'KEEP_ALIVE' }));
          } catch (e) {
            // 전송 실패 시 무시
          }
        }
      }
    }, 5000); // 5초마다

    logInfo('[SwarmManager]', 'Keep-alive started');
  }

  /**
   * Keep-alive 중지
   */
  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      logInfo('[SwarmManager]', 'Keep-alive stopped');
    }
  }

  /**
   * 리소스 정리 (컴포넌트 언마운트 시 호출)
   */
  public cleanup(): void {
    logInfo('[SwarmManager]', 'Cleaning up (Full)...');
    this.resetState();
    this.removeSignalingHandlers();
  }

  /**
   * 상태 초기화 (재사용 시 호출)
   */
  private resetState(): void {
    logInfo('[SwarmManager]', 'Resetting state...');

    this.isTransferring = false;
    this.isProcessingBatch = false;
    this.awaitingWorkerResume = false;
    this.pendingWorkerResumeOffset = null;
    this.roomId = null;
    this.clearWorkerBatchTimeout();
    this.stopTransferPumpWatchdog();
    this.stopAdaptiveControl();

    // Keep-alive 정리
    this.stopKeepAlive();

    // Ready 타이머 정리
    this.clearReadyTimeout();

    // 모든 타임아웃 정리
    for (const timeout of this.connectionTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.connectionTimeouts.clear();

    // 모든 피어 정리
    for (const peer of this.peers.values()) {
      peer.destroy();
    }
    this.peers.clear();

    // Worker 정리
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.pendingManifest = null;
    this.totalBytesSent = 0;
    this.completedPeerCount = 0;

    // 대기열 시스템 초기화
    this.transferQueue = [];
    this.completedPeersInSession.clear();
    this.currentTransferPeers.clear();
    this.pausedPeers.clear();
    this.pendingAckPeers.clear();
    this.partitionAckWaiters.clear();
    this.notifySendWindowWaiters();
    this.cryptoSessionAnnouncedPeers.clear();
    if (this.sessionKey) {
      this.sessionKey.fill(0);
    }
    if (this.randomPrefix) {
      this.randomPrefix.fill(0);
    }
    this.sessionKey = null;
    this.randomPrefix = null;
    this.encryptionEnabled = false;
    this.files = [];
  }

  /**
   * 🚀 [대기열] 대기열 상태 조회
   */
  public getQueueState() {
    return {
      queueSize: this.transferQueue.length,
      currentTransferPeers: [...this.currentTransferPeers],
      completedPeers: [...this.completedPeersInSession],
      waitingPeers: this.getConnectedPeers()
        .filter(p => !p.ready && !this.completedPeersInSession.has(p.id))
        .map(p => p.id),
    };
  }
}

// 참고: 싱글톤 대신 SenderView에서 인스턴스를 직접 생성하여 사용
// 이렇게 하면 각 전송 세션이 독립적으로 관리됨
