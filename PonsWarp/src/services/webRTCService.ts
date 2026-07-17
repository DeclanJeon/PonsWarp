import { TurnConfigResponse } from './signaling';
import { getSignalingService, ISignalingService } from './signaling-factory';
const defaultSignalingService = () => getSignalingService();
import {
  logInfo,
  logError,
  logWarn,
  logDebug,
  debugLog,
} from '../utils/logger';
import {
  downloadHybridAssistPackets,
  localHybridCaps,
  type HybridManifestMsg,
} from './hybridBulkTransport';
import { createEosPacket } from '../utils/plainPacket';
import { SinglePeerConnection, PeerConfig } from './singlePeerConnection';
import { base64ToBytes, CryptoService } from './cryptoService';
import { TransferManifest } from '../types/types';
import { getErrorMessage } from '../utils/errors';
import { shouldKeepReceiverReconnectAlive } from '../utils/mobileResumePolicy';

import { lanEvidenceAdapter } from './lanEvidenceAdapter';
export interface ReceiverServiceOptions {
  signaling?: ISignalingService;
  peerFactory?: (
    peerId: string,
    initiator: boolean,
    config: PeerConfig
  ) => SinglePeerConnection;
  writer?: IFileWriter;
  clock?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;
  output?: { emit?: (event: { type: string; data: unknown }) => void };
}
type EventHandler = (data: unknown) => void;
type PeerSignalData = Parameters<SinglePeerConnection['signal']>[0];
type ReceiverSignalMessage = {
  from: string;
  offer?: PeerSignalData;
  candidate?: PeerSignalData;
  sdp?: unknown;
};
type ReceiverProgressPayload =
  | number
  | {
      progress: number;
      speed: number;
      bytesTransferred: number;
      totalBytes: number;
    };

// Writer 인터페이스 정의
export interface IFileWriter {
  initStorage(manifest: TransferManifest): Promise<void>;
  writeChunk(packet: ArrayBuffer): Promise<void>;
  cleanup(): Promise<void>;
  onProgress(
    cb: (progress: {
      progress: number;
      speed: number;
      bytesTransferred: number;
      totalBytes: number;
    }) => void
  ): void;
  onComplete(cb: (actualSize: number) => void): void;
  onError(cb: (err: string) => void): void;
  // 🚀 [추가] 흐름 제어 인터페이스
  onFlowControl?(cb: (action: 'PAUSE' | 'RESUME') => void): void;
  onResumeRequest?(cb: (offset: number, reason: string) => void): void;
  requestResumeFromCurrentOffset?(reason: string): boolean;
  waitForIdle?(): Promise<void>;
  getContiguousReceivedOffset?(): number;
  // 🔐 [E2E] 암호화 키 설정
  setEncryptionKey?(sessionKey: Uint8Array, randomPrefix: Uint8Array): void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;


const STRIPE_SEP = '::stripe::';
function normalizeLaneSignal(raw: unknown): { signal: any; lane: number } {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { signal: raw, lane: 0 };
    }
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const lane = Number(obj.lane ?? 0);
    if ('lane' in obj) {
      const { lane: _l, ...rest } = obj;
      return { signal: rest, lane: Number.isFinite(lane) ? lane : 0 };
    }
    return { signal: obj, lane: Number.isFinite(lane) ? lane : 0 };
  }
  return { signal: raw, lane: 0 };
}

export class ReceiverService {
  // 연결 관리
  private peer: SinglePeerConnection | null = null;
  /** Additional bulk PeerConnections keyed by lane (>0) */
  private stripePeers: Map<number, SinglePeerConnection> = new Map();
  private hybridManifest: HybridManifestMsg | null = null;
  private hybridDownloadAbort: AbortController | null = null;
  private hybridBytesReceived = 0;
  private hybridPacketsReceived = 0;


  private signalingService: ISignalingService | null = null;
  private readonly peerFactory: (
    peerId: string,
    initiator: boolean,
    config: PeerConfig
  ) => SinglePeerConnection;
  private readonly clock: Pick<
    typeof globalThis,
    'setTimeout' | 'clearTimeout'
  >;
  private disposed = false;
  private readonly output?: ReceiverServiceOptions['output'];
  private roomId: string | null = null;

  // 파일 쓰기
  private writer: IFileWriter | null = null;
  private currentManifest: TransferManifest | null = null;
  private isTransferActive = false;
  // 🚀 [Mobile] Wake Lock (화면 꺼짐 방지)
  private wakeLockSentinel: any = null;

  private async requestWakeLock(): Promise<void> {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    try {
      this.wakeLockSentinel = await (navigator as any).wakeLock.request('screen');
      logInfo('[Receiver]', '🔒 Wake Lock acquired');
      this.wakeLockSentinel.addEventListener('release', () => {
        this.wakeLockSentinel = null;
        if (this.isTransferActive) this.requestWakeLock();
      });
    } catch (e) {
      logDebug('[Receiver]', 'Wake Lock not available:', e);
    }
  }

  private releaseWakeLock(): void {
    if (this.wakeLockSentinel) {
      this.wakeLockSentinel.release().catch(() => {});
      this.wakeLockSentinel = null;
    }
  }
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readyRetryTimers: ReturnType<typeof setTimeout>[] = [];
  private lifecycleTimers = new Set<ReturnType<typeof setTimeout>>();
  private readySignalGeneration = 0;
  private lastPartitionOffsetNeedingAck: number | null = null;
  private lastPartitionRunIdNeedingAck: number | null = null;

  // 상태 관리
  private eventListeners: Record<string, EventHandler[]> = {};
  private connectedPeerId: string | null = null; // 연결된 Sender ID

  // ICE 서버 설정 (기본값)
  private iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
  ];

  // 🚨 [추가] TURN 설정 로딩 상태를 추적하기 위한 Promise
  private turnConfigPromise: Promise<void> | null = null;
  private pendingIceCandidates: PeerSignalData[] = [];
  private writerCleanup: Promise<void> = Promise.resolve();
  private completionEmitted = false;
  private isPartitionMode = false; // 파티션 모드 감지 (per-chunk ACK 불필요)

  // 🔐 [E2E Encryption]
  private cryptoService: CryptoService | null = null;
  private encryptionEnabled: boolean = false;
  private sessionKey: Uint8Array | null = null;
  private randomPrefix: Uint8Array | null = null;

  // Bound Handlers
  private handleRoomFull = () => {
    this.emit('room-full', 'Room is currently occupied. Please wait.');
  };
  private readonly handleVisibilityChange = () => {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible'
    ) {
      this.handlePageBecameActive();
    }
  };

  constructor(options: ReceiverServiceOptions = {}) {
    this.signalingService = options.signaling ?? null;
    this.peerFactory =
      options.peerFactory ??
      ((peerId, initiator, config) =>
        new SinglePeerConnection(peerId, initiator, config));
    this.clock = options.clock ?? globalThis;
    this.output = options.output;
    this.writer = options.writer ?? null;
    if (this.signalingService) this.setupSignalingHandlers();
    this.setupPageLifecycleHandlers();
  }
  private ensureSignalingService(): ISignalingService {
    if (!this.signalingService) {
      this.signalingService = defaultSignalingService();
      this.setupSignalingHandlers();
    }
    return this.signalingService;
  }

  private readonly handlePageBecameActive = (_event?: Event) => {
    if (this.disposed || !this.roomId || !this.isTransferActive) return;

    if (this.peer && this.peer.connected) {
      return;
    }

    if (!this.reconnectTimer) {
      this.scheduleReconnect({ immediate: true });
    }
  };

  private setupPageLifecycleHandlers(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined')
      return;

    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('pageshow', this.handlePageBecameActive);
    window.addEventListener('focus', this.handlePageBecameActive);
  }

  private isPageHidden(): boolean {
    return (
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
    );
  }

  private getCurrentFileCount(): number {
    return (
      this.currentManifest?.totalFiles ??
      this.currentManifest?.files?.length ??
      0
    );
  }

  private shouldKeepResumableSessionAlive(): boolean {
    return shouldKeepReceiverReconnectAlive({
      isTransferActive: this.isTransferActive,
      hasRoom: !!this.roomId,
      hasWriter: !!this.writer,
      fileCount: this.getCurrentFileCount(),
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
      pageHidden: this.isPageHidden(),
    });
  }

  private sendResumeHints(
    reason: string,
    options: {
      includePartitionAck: boolean;
      requestResume: boolean;
    }
  ): void {
    if (!this.peer || !this.peer.connected) return;

    this.peer.send(JSON.stringify({ type: 'CONTROL', action: 'RESUME' }));

    if (
      options.includePartitionAck &&
      this.lastPartitionOffsetNeedingAck !== null &&
      this.lastPartitionRunIdNeedingAck !== null
    ) {
      this.peer.send(
        JSON.stringify({
          type: 'PARTITION_ACK',
          offset: this.lastPartitionOffsetNeedingAck,
          runId: this.lastPartitionRunIdNeedingAck,
        })
      );
    }

    if (options.requestResume) {
      this.writer?.requestResumeFromCurrentOffset?.(reason);
    }
  }

  /**
   * 🔐 E2E 암호화 활성화
   */
  public enableEncryption(): void {
    this.cryptoService = new CryptoService();
    this.encryptionEnabled = true;
    logInfo('[Receiver]', '🔐 E2E encryption enabled');
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

    // Writer에도 키 전달
    if (this.writer?.setEncryptionKey) {
      this.writer.setEncryptionKey(sessionKey, randomPrefix);
    }

    logInfo('[Receiver]', '🔐 Session key set');
  }

  /**
   * 🔐 암호화 활성화 여부
   */
  public isEncryptionEnabled(): boolean {
    return this.encryptionEnabled;
  }

  private setupSignalingHandlers() {
    this.ensureSignalingService().on('offer', this.handleOffer);
    this.ensureSignalingService().on('ice-candidate', this.handleIceCandidate);
    this.ensureSignalingService().on('room-full', this.handleRoomFull);
    // Receiver는 'answer'를 받을 일이 없음 (Answerer 역할이므로)
  }

  private removeSignalingHandlers() {
    this.signalingService?.off('offer', this.handleOffer);
    this.signalingService?.off('ice-candidate', this.handleIceCandidate);
    this.signalingService?.off('room-full', this.handleRoomFull);
  }

  // ======================= PUBLIC API =======================

  public async initReceiver(roomId: string) {
    if (this.disposed) return;
    if (this.roomId === roomId && this.isConnected()) {
      debugLog('[Receiver] Already connected to room:', roomId);
      return;
    }

    debugLog('[Receiver] Initializing connection for room:', roomId);

    // 기존 연결 정리 (Adapter의 연결은 끊지 않고 피어 상태만 정리)
    await this.resetState();
    this.roomId = roomId;

    try {
      // 1. 시그널링 연결 (이미 연결되어 있다면 즉시 resolve됨)
      await this.ensureSignalingService().connect();

      // 2. 방 입장
      await this.ensureSignalingService().joinRoom(roomId);

      // 3. TURN 설정 요청
      // Rust 서버의 경우 WebSocket으로 요청하므로 응답을 기다립니다.
      // 실패하더라도(타임아웃) P2P 연결 시도를 막지 않도록 catch 처리
      this.turnConfigPromise = this.fetchTurnConfig(roomId).catch(e => {
        console.warn(
          '[Receiver] TURN config fetch failed (using default STUN):',
          e
        );
      });

      // UI 상태 변경
      this.emit('status', 'CONNECTING');
    } catch (error) {
      logError('[Receiver] Initialization failed:', error);
      this.emit('error', getErrorMessage(error, 'Initialization failed'));
    }
  }

  public async setWriter(writerInstance: IFileWriter) {
    if (this.disposed) return;
    this.writerCleanup = this.writer
      ? this.writer.cleanup()
      : Promise.resolve();
    await this.writerCleanup;
    this.writer = writerInstance;

    if (this.sessionKey && this.randomPrefix && this.writer.setEncryptionKey) {
      this.writer.setEncryptionKey(this.sessionKey, this.randomPrefix);
    }

    // Writer 이벤트 연결
    this.writer.onProgress((progressData: ReceiverProgressPayload) => {
      // 객체 형태면 그대로, 숫자면 변환
      if (typeof progressData === 'object') {
        this.emit('progress', progressData);
      } else {
        this.emit('progress', {
          progress: progressData,
        });
      }
    });

    this.writer.onComplete(actualSize => {
      void (async () => {
        if (this.completionEmitted) return;
        try {
          if (lanEvidenceAdapter.enabled) {
            await this.writer?.waitForIdle?.();
            const expectedSha256 =
              this.currentManifest?.files?.length === 1
                ? this.currentManifest.files[0].checksum
                : undefined;
            await lanEvidenceAdapter.uploadSavedFileReadback({
              artifactId: this.currentManifest?.transferId || 'transfer',
              expectedSize: actualSize,
              expectedSha256,
            });
          }
          this.completionEmitted = true;
          this.isTransferActive = false;
          this.isReconnecting = false;
          this.emit('complete', { actualSize });
          this.notifyDownloadComplete(actualSize);
        } catch (error) {
          this.emit(
            'error',
            getErrorMessage(error, 'Evidence readback failed')
          );
        }
      })();
    });

    this.writer.onError(err => this.emit('error', err));

    // 🚀 [Flow Control] 이벤트 연결
    if (this.writer.onFlowControl) {
      this.writer.onFlowControl(action => {
        if (this.peer && this.peer.connected) {
          logDebug('[Receiver]', `Sending flow control: ${action}`);
          try {
            this.peer.send(JSON.stringify({ type: 'CONTROL', action }));
          } catch (e) {
            logError('[Receiver]', 'Failed to send control message', e);
          }
        }
      });
    }

    if (this.writer.onResumeRequest) {
      this.writer.onResumeRequest((offset, reason) => {
        if (!this.peer || !this.peer.connected) {
          this.emit('error', 'Cannot resume transfer: peer disconnected');
          return;
        }

        const sent = this.peer.send(
          JSON.stringify({
            type: 'RESUME_REQUEST',
            offset,
            reason,
          })
        );

        if (!sent) {
          this.emit('error', 'Cannot resume transfer: data channel closed');
        }
      });
    }
  }

  /**
   * 저장소 준비 완료 후 수신 시작
   */
  public async startReceiving(manifest: TransferManifest) {
    if (this.disposed) return;
    await this.writerCleanup;
    if (!this.writer) {
      this.emit('error', 'Storage writer not initialized');
      return;
    }

    try {
      debugLog('[Receiver] Initializing storage writer...');
      this.currentManifest = manifest;
      this.completionEmitted = false;
      await this.writer.initStorage(manifest);

      debugLog('[Receiver] ✅ Storage ready. Sending TRANSFER_READY...');
      await lanEvidenceAdapter.reportPhase('RECEIVER_READY', {
        transferId: manifest.transferId,
        totalBytes: manifest.totalSize,
      });
      this.emit('storage-ready', true);
      this.emit('status', 'RECEIVING');
      this.isTransferActive = true;
      this.requestWakeLock(); // 📱 화면 꺼짐 방지
      this.isReconnecting = false;
      this.reconnectAttempts = 0;

      // Sender에게 준비 완료 신호 전송. 일부 브라우저는 data channel open 직후
      // 첫 control frame을 조용히 누락시키는 경우가 있어 짧게 재전송한다.
      if (this.peer && this.peer.connected) {
        this.scheduleTransferReadyRetries(
          JSON.stringify({ type: 'TRANSFER_READY' }),
          this.peer
        );
      } else {
        throw new Error('Peer disconnected during storage init');
      }
    } catch (error) {
      console.error('[Receiver] Storage init failed:', error);
      this.emit(
        'error',
        getErrorMessage(error, 'Failed to initialize storage')
      );
    }
  }

  public cleanup() {
    if (this.disposed) return;
    this.disposed = true;
    logInfo('[Receiver]', 'Cleaning up resources (Full)...');
    void this.resetState().catch(error =>
      this.emit('error', getErrorMessage(error, 'Cleanup failed'))
    );
    this.removeSignalingHandlers();
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      document.removeEventListener(
        'visibilitychange',
        this.handleVisibilityChange
      );
      window.removeEventListener('pageshow', this.handlePageBecameActive);
      window.removeEventListener('focus', this.handlePageBecameActive);
    }
  }

  private async resetState() {
    logInfo('[Receiver]', 'Resetting state...');
    this.releaseWakeLock();
    this.roomId = null;
    this.connectedPeerId = null;
    this.pendingIceCandidates = [];
    this.currentManifest = null;
    this.isTransferActive = false;
    this.isPartitionMode = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;

    if (this.reconnectTimer) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearReadyRetryTimers();

    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    for (const stripe of this.stripePeers.values()) {
      try {
        stripe.destroy();
      } catch {
        /* ignore */
      }
    }
    this.stripePeers.clear();

    if (this.writer) {
      await this.writer.cleanup();
      // writer는 null로 만들지 않음 (재사용 가능성 고려)
    }

    if (this.sessionKey) {
      this.sessionKey.fill(0);
    }
    if (this.randomPrefix) {
      this.randomPrefix.fill(0);
    }
    this.sessionKey = null;
    this.randomPrefix = null;
    this.encryptionEnabled = false;
    this.cryptoService?.cleanup();
    this.cryptoService = null;
    this.clearLifecycleTimers();
  }

  private setTimeout(
    callback: () => void,
    delay: number
  ): ReturnType<typeof setTimeout> {
    const timer = this.clock.setTimeout(() => {
      this.lifecycleTimers.delete(timer);
      callback();
    }, delay);
    this.lifecycleTimers.add(timer);
    return timer;
  }

  private clearLifecycleTimers(): void {
    for (const timer of this.lifecycleTimers) {
      this.clock.clearTimeout(timer);
    }
    this.lifecycleTimers.clear();
  }

  // ======================= INTERNAL LOGIC =======================

  private clearReadyRetryTimers(): void {
    for (const timer of this.readyRetryTimers) {
      this.clock.clearTimeout(timer);
    }
    this.readyRetryTimers = [];
    this.readySignalGeneration++;
  }

  private scheduleTransferReadyRetries(
    readyMessage: string,
    readyPeer: SinglePeerConnection
  ): void {
    this.clearReadyRetryTimers();
    const generation = this.readySignalGeneration;

    for (const delay of [0, 100, 300, 1000]) {
      const timer = this.setTimeout(() => {
        if (
          generation !== this.readySignalGeneration ||
          this.peer !== readyPeer ||
          !readyPeer.connected
        ) {
          return;
        }

        readyPeer.send(readyMessage);
      }, delay);
      this.readyRetryTimers.push(timer);
    }
  }
  private isConnected(): boolean {
    return this.peer ? this.peer.connected : false;
  }

  private async fetchTurnConfig(roomId: string) {
    try {
      const response = (await this.ensureSignalingService().requestTurnConfig(
        roomId
      )) as TurnConfigResponse;
      if (response?.success && response?.data) {
        this.iceServers = this.orderIceServersPreferDirect(
          response.data.iceServers
        );
      }
    } catch (error) {
      logError('[Receiver]', 'Failed to fetch TURN config:', error);
      throw error;
    }
  }

  /**
   * Sender로부터 Offer 수신 시 처리
   */
  private handleOffer = async (d: ReceiverSignalMessage) => {
    debugLog('[Receiver] Offer received from:', d.from);

    if (this.connectedPeerId && d.from !== this.connectedPeerId) {
      logWarn('[Receiver]', `Ignoring offer from unknown peer: ${d.from}`);
      return;
    }

    if (!this.connectedPeerId) {
      this.connectedPeerId = d.from;
    }

    if (this.turnConfigPromise) {
      try {
        await this.turnConfigPromise;
      } catch {
        console.warn(
          '[Receiver] TURN config failed, proceeding with default STUN'
        );
      }
    }

    const { signal, lane } = normalizeLaneSignal(d.offer ?? d.sdp);
    const config: PeerConfig = {
      iceServers: this.iceServers,
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 4,
    };

    if (lane > 0) {
      // Bulk stripe PeerConnection — do not tear down primary
      let stripe = this.stripePeers.get(lane);
      if (stripe) {
        stripe.destroy();
      }
      stripe = this.peerFactory(`${d.from}::stripe::${lane}`, false, config);
      this.stripePeers.set(lane, stripe);
      this.setupStripePeerEvents(stripe, lane);
      stripe.signal(signal);
      return;
    }

    // Primary control/data connection
    if (this.peer) {
      this.peer.destroy();
    }
    this.peer = this.peerFactory(d.from, false, config);
    this.setupPeerEvents(this.peer);
    this.peer.signal(signal);
    for (const candidate of this.pendingIceCandidates.splice(0)) {
      const normalized = normalizeLaneSignal(candidate);
      if (normalized.lane === 0) this.peer.signal(normalized.signal);
      else {
        const stripe = this.stripePeers.get(normalized.lane);
        stripe?.signal(normalized.signal);
      }
    }
  };

  private handleIceCandidate = (d: ReceiverSignalMessage) => {
    if (this.connectedPeerId && d.from !== this.connectedPeerId) return;
    if (!d.candidate) return;

    const { signal, lane } = normalizeLaneSignal(d.candidate);
    if (lane > 0) {
      const stripe = this.stripePeers.get(lane);
      if (stripe && !stripe.isDestroyed()) stripe.signal(signal);
      else this.pendingIceCandidates.push(d.candidate);
      return;
    }

    if (!this.peer || this.peer.isDestroyed()) {
      this.pendingIceCandidates.push(d.candidate);
      return;
    }

    this.peer.signal(signal);
  };

  private setupStripePeerEvents(peer: SinglePeerConnection, lane: number): void {
    peer.on('signal', (data: any) => {
      if (data?.type === 'answer') {
        this.ensureSignalingService().sendAnswer(
          this.roomId!,
          { ...data, lane },
          this.connectedPeerId || peer.id
        );
      } else if (data?.candidate) {
        this.ensureSignalingService().sendCandidate(
          this.roomId!,
          { ...data, lane } as any,
          this.connectedPeerId || peer.id
        );
      }
    });
    peer.on('connected', () => {
      logInfo('[Receiver]', `Stripe lane ${lane} connected`);
    });
    peer.on('data', (data: ArrayBuffer | string) => {
      // Answer probe pings on the same bulk lane that received them.
      if (typeof data === 'string') {
        try {
          if (data.startsWith('{')) {
            const msg = JSON.parse(data);
            if (msg?.type === 'STRIPE_PING' || msg?.type === 'STRIPE_BULK_PING') {
              peer.send(
                JSON.stringify({
                  type: msg.type === 'STRIPE_BULK_PING' ? 'STRIPE_BULK_PONG' : 'STRIPE_PONG',
                  lane,
                  n: msg.n ?? 0,
                })
              );
              return;
            }
          }
        } catch {
          /* fall through */
        }
      } else if (data instanceof ArrayBuffer && data.byteLength > 0) {
        const u8 = new Uint8Array(data);
        // Binary bulk probe: magic 'SPING' (0x53 50 49 4e 47) + lane + n
        if (
          data.byteLength >= 8 &&
          u8[0] === 0x53 &&
          u8[1] === 0x50 &&
          u8[2] === 0x49 &&
          u8[3] === 0x4e &&
          u8[4] === 0x47
        ) {
          peer.send(
            JSON.stringify({
              type: 'STRIPE_BULK_PONG',
              lane: u8[5],
              n: u8[6],
            })
          );
          return;
        }
        if (data.byteLength < 256 && u8[0] === 123) {
          try {
            const msg = JSON.parse(new TextDecoder().decode(data));
            if (msg?.type === 'STRIPE_PING' || msg?.type === 'STRIPE_BULK_PING') {
              peer.send(
                JSON.stringify({
                  type:
                    msg.type === 'STRIPE_BULK_PING'
                      ? 'STRIPE_BULK_PONG'
                      : 'STRIPE_PONG',
                  lane,
                  n: msg.n ?? 0,
                })
              );
              return;
            }
          } catch {
            /* fall through */
          }
        }
      }
      this.handleData(data);
    });
    peer.on('error', (err: Error) => {
      logError('[Receiver]', `Stripe lane ${lane} error:`, err);
    });
    peer.on('close', () => {
      this.stripePeers.delete(lane);
    });
  }

  private setupPeerEvents(peer: SinglePeerConnection) {
    peer.on('signal', (raw: unknown) => {
      // Receiver는 Answer와 Candidate를 Sender에게 보냄
      const data = raw as {
        type?: string;
        sdp?: string;
        candidate?: RTCIceCandidateInit | null;
      };
      if (data.type === 'answer' && typeof data.sdp === 'string') {
        this.ensureSignalingService().sendAnswer(
          this.roomId!,
          data as unknown as PeerSignalData,
          peer.id
        );
      } else if (data.type === 'candidate' || data.candidate) {
        this.ensureSignalingService().sendCandidate(
          this.roomId!,
          data as unknown as PeerSignalData,
          peer.id
        );
      }
    });

    peer.on('connected', () => {
      logInfo('[Receiver]', 'P2P Channel Connected!');
      this.emit('connected', true);
      try {
        const caps = localHybridCaps();
        peer.send(JSON.stringify({ type: 'PEER_CAPS', ...caps }));
      } catch (error) {
        logWarn('[Receiver]', 'Failed to send PEER_CAPS', error);
      }

      if (this.isReconnecting) {
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          this.clock.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.emit('status', 'RECEIVING');
        this.emit('reconnected', true);
        this.sendResumeHints('connection restored after data channel close', {
          includePartitionAck: true,
          requestResume: true,
        });
      }
    });

    peer.on('data', this.handleData.bind(this));

    peer.on<Error>('error', err => {
      if (this.completionEmitted) return;
      logError('[Receiver]', 'Peer error:', err);
      this.emit('error', getErrorMessage(err, 'Peer error'));
    });

    peer.on('close', () => {
      if (this.completionEmitted) return;
      logInfo('[Receiver]', 'Peer connection closed');
      if (this.shouldAttemptReconnect()) {
        this.scheduleReconnect();
        return;
      }

      this.emit('error', 'Connection closed');
    });
  }

  private shouldAttemptReconnect(): boolean {
    return (
      this.isTransferActive &&
      !!this.roomId &&
      !!this.writer &&
      !!this.currentManifest &&
      (this.currentManifest.totalFiles ??
        this.currentManifest.files?.length ??
        0) > 0 &&
      this.shouldKeepResumableSessionAlive()
    );
  }

  private scheduleReconnect(options: { immediate?: boolean } = {}): void {
    if (!this.roomId || this.reconnectTimer) {
      return;
    }

    this.isReconnecting = true;
    if (
      !this.isPageHidden() ||
      this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS
    ) {
      this.reconnectAttempts++;
    }
    this.connectedPeerId = null;

    const delay = options.immediate
      ? 0
      : Math.min(
          RECONNECT_BASE_DELAY_MS * Math.max(1, this.reconnectAttempts),
          5000
        );

    logWarn(
      '[Receiver]',
      `Scheduling reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`
    );
    this.emit('reconnecting', {
      attempt: this.reconnectAttempts,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
    });

    const roomId = this.roomId;
    this.reconnectTimer = this.setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.disposed) return;

      try {
        await this.ensureSignalingService().connect();
        if (this.disposed) return;

        try {
          await this.ensureSignalingService().leaveRoom(roomId);
        } catch {
          // Rejoin still has a chance to trigger a fresh offer.
        }

        await new Promise<void>(resolve => this.setTimeout(resolve, 250));
        if (this.disposed) return;
        await this.ensureSignalingService().joinRoom(roomId);
        this.reconnectTimer = this.setTimeout(() => {
          this.reconnectTimer = null;
          if (this.disposed) return;

          if (this.isReconnecting && this.shouldAttemptReconnect()) {
            this.scheduleReconnect();
            return;
          }

          if (this.isReconnecting && this.isPageHidden()) {
            logWarn(
              '[Receiver]',
              'Reconnect window expired while page is hidden; keeping resumable session alive until foreground'
            );
            return;
          }

          if (this.isReconnecting) {
            this.isReconnecting = false;
            this.isTransferActive = false;
            this.emit(
              'error',
              'Connection lost and automatic reconnect failed'
            );
          }
        }, 5000);
      } catch (error) {
        logError('[Receiver]', 'Reconnect attempt failed:', error);

        if (this.shouldAttemptReconnect()) {
          this.scheduleReconnect();
          return;
        }

        if (this.isPageHidden()) {
          logWarn(
            '[Receiver]',
            'Reconnect failed while page is hidden; keeping resumable session alive until foreground'
          );
          return;
        }

        this.isReconnecting = false;
        this.isTransferActive = false;
        this.emit(
          'error',
          error?.message || 'Connection lost and automatic reconnect failed'
        );
      }
    }, delay);

    if (this.peer && !this.peer.isDestroyed()) {
      this.peer.destroy();
    }
    this.peer = null;
  }


  private async consumeHybridObject(manifest: HybridManifestMsg): Promise<void> {
    if (!this.writer) {
      logWarn('[Receiver]', 'Hybrid ready but writer not initialized yet');
      setTimeout(() => {
        if (this.writer && this.hybridManifest?.shareId === manifest.shareId) {
          void this.consumeHybridObject(manifest);
        }
      }, 250);
      return;
    }
    this.hybridDownloadAbort?.abort();
    this.hybridDownloadAbort = new AbortController();
    try {
      const result = await downloadHybridAssistPackets(
        manifest,
        async packet => {
          if (!this.writer) return;
          await this.writer.writeChunk(packet);
          this.hybridPacketsReceived += 1;
          this.hybridBytesReceived += packet.byteLength;
        },
        { signal: this.hybridDownloadAbort.signal }
      );
      logInfo(
        '[Receiver]',
        `Hybrid download complete packets=${result.packetCount} bytes=${result.bytes}`
      );
      this.emit('hybrid-progress', {
        hybridBytesReceived: this.hybridBytesReceived,
        hybridPacketsReceived: this.hybridPacketsReceived,
      });
      // Hybrid-primary path: if contiguous payload is complete, inject EOS so
      // the writer finalizes without waiting for WebRTC bulk.
      const frontier = this.writer?.getContiguousReceivedOffset?.() ?? 0;
      const expected =
        manifest.totalPayloadBytes || this.currentManifest?.totalSize || 0;
      if (expected > 0 && frontier >= expected) {
        logInfo(
          '[Receiver]',
          `Hybrid filled payload (${frontier}/${expected}); injecting EOS`
        );
        await this.writer.writeChunk(createEosPacket());
      }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      logWarn(
        '[Receiver]',
        'Hybrid download failed; WebRTC path continues',
        error
      );
    }
  }

  private handleData(data: ArrayBuffer | string) {
    // 1. 제어 메시지 (JSON 문자열)
    if (this.isControlMessage(data)) {
      void this.handleControlMessage(data);
      return;
    }

    if (!(data instanceof ArrayBuffer)) {
      logWarn('[Receiver]', 'Ignoring non-binary non-control data frame');
      return;
    }

    // 2. 파일 데이터 (Binary) -> Writer로 전달
    if (this.writer) {
      this.writer
        .writeChunk(data)
        .then(() => {
          // Per-chunk ACKs are disabled. Partition markers carry durability
          // checkpoints; reliable SCTP already retransmits lost packets.
        })
        .catch(err => {
          console.error('[Receiver] Write error:', err);
          this.emit(
            'error',
            err instanceof Error ? err.message : 'Disk write failed'
          );
        });
    }
  }

  private isControlMessage(data: ArrayBuffer | string): boolean {
    if (typeof data === 'string') {
      return data.trimStart().startsWith('{');
    }

    return data.byteLength > 0 && new Uint8Array(data)[0] === 123;
  }

  private async handleControlMessage(data: ArrayBuffer | string) {
    try {
      const str =
        typeof data === 'string' ? data : new TextDecoder().decode(data);
      const msg = JSON.parse(str);

      switch (msg.type) {
        case 'CRYPTO_SESSION': {
          const sessionKey = base64ToBytes(msg.key);
          const randomPrefix = base64ToBytes(msg.randomPrefix);
          this.setSessionKey(sessionKey, randomPrefix);
          this.encryptionEnabled = true;
          logInfo('[Receiver]', '🔐 Crypto session received');
          break;
        }
        case 'MANIFEST':
          logInfo('[Receiver]', 'Manifest received');
          this.emit('metadata', msg.manifest);
          break;
        case 'TRANSFER_STARTED':
          logInfo('[Receiver]', 'Sender started transfer');
          // Sender always uses partitioned binary transfer now. Disable
          // per-chunk ACKs immediately so reverse-path control frames do not
          // throttle the DataChannel during LAN bulk transfer.
          this.isPartitionMode = true;
          this.emit('remote-started', true);
          break;
        case 'TRANSFER_STARTED_WITHOUT_YOU':
          this.emit('transfer-missed', msg.message);
          break;
        case 'QUEUED':
          this.emit('queued', { message: msg.message, position: msg.position });
          break;
        case 'TRANSFER_STARTING':
          this.emit('transfer-starting', true);
          this.emit('status', 'RECEIVING');
          break;
        case 'READY_FOR_DOWNLOAD':
          this.emit('ready-for-download', { message: msg.message });
          break;
        case 'KEEP_ALIVE':
          // 무시
          break;
        case 'HYBRID_MANIFEST': {
          if (
            typeof msg.runId !== 'number' ||
            typeof msg.shareId !== 'string' ||
            typeof msg.fileId !== 'string'
          ) {
            break;
          }
          this.hybridManifest = msg as HybridManifestMsg;
          logInfo(
            '[Receiver]',
            `Hybrid manifest received share=${msg.shareId}`
          );
          break;
        }
        case 'HYBRID_READY': {
          if (
            typeof msg.runId !== 'number' ||
            typeof msg.shareId !== 'string' ||
            typeof msg.fileId !== 'string'
          ) {
            break;
          }
          const manifest =
            this.hybridManifest &&
            this.hybridManifest.shareId === msg.shareId &&
            this.hybridManifest.fileId === msg.fileId
              ? this.hybridManifest
              : (msg as HybridManifestMsg);
          // Fill required fields if READY arrives with full payload
          const full: HybridManifestMsg = {
            type: 'HYBRID_MANIFEST',
            runId: manifest.runId ?? msg.runId,
            shareId: msg.shareId,
            fileId: msg.fileId,
            objectBytes: (manifest as HybridManifestMsg).objectBytes ?? 0,
            packetCount: (manifest as HybridManifestMsg).packetCount ?? 0,
            totalPayloadBytes:
              (manifest as HybridManifestMsg).totalPayloadBytes ?? 0,
            downloadSessionToken: (manifest as HybridManifestMsg)
              .downloadSessionToken,
          };
          this.hybridManifest = full;
          void this.consumeHybridObject(full);
          break;
        }
        case 'HYBRID_ABORT': {
          this.hybridDownloadAbort?.abort();
          this.hybridDownloadAbort = null;
          logWarn('[Receiver]', 'Hybrid assist aborted by peer');
          break;
        }
        case 'PARTITION':
          {
            this.isPartitionMode = true; // 파티션 모드 감지
            if (
              typeof msg.offset !== 'number' ||
              !Number.isFinite(msg.offset) ||
              typeof msg.runId !== 'number' ||
              !Number.isInteger(msg.runId)
            ) {
              break;
            }

            this.lastPartitionOffsetNeedingAck = msg.offset;
            this.lastPartitionRunIdNeedingAck = msg.runId;

            // Multi-PC striping delivers chunks out-of-order across associations.
            // Never ACK until the contiguous reordering frontier reaches offset.
            const deadline = Date.now() + 120_000;
            while (true) {
              await this.writer?.waitForIdle?.();
              const frontier =
                this.writer?.getContiguousReceivedOffset?.() ?? 0;
              if (frontier >= msg.offset) break;
              if (Date.now() > deadline) {
                throw new Error(
                  `Partition wait timed out at offset ${msg.offset} (frontier ${frontier})`
                );
              }
              await new Promise(r => setTimeout(r, 10));
            }

            if (this.peer && this.peer.connected) {
              this.peer.send(
                JSON.stringify({
                  type: 'PARTITION_ACK',
                  offset: msg.offset,
                  runId: msg.runId,
                })
              );
              this.lastPartitionOffsetNeedingAck = null;
              this.lastPartitionRunIdNeedingAck = null;
            }
          }
          break;
      }
    } catch (error) {
      const message = getErrorMessage(
        error,
        'Failed to handle control message'
      );
      logError('[Receiver]', 'Control message handling failed:', error);
      this.emit('error', message);
    }
  }

  private notifyDownloadComplete(actualSize: number) {
    if (this.peer && this.peer.connected) {
      const msg = JSON.stringify({
        type: 'DOWNLOAD_COMPLETE',
        actualSize,
        expectedSize: this.currentManifest?.totalSize,
      });
      // 신뢰성을 위해 여러 번 전송
      for (let i = 0; i < 3; i++) {
        this.setTimeout(() => {
          this.peer?.send(msg);
        }, i * 100);
      }
    }
  }

  // ======================= EVENT EMITTER =======================

  public on(event: string, handler: EventHandler) {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(handler);
  }

  public off(event: string, handler: EventHandler) {
    if (!this.eventListeners[event]) return;
    this.eventListeners[event] = this.eventListeners[event].filter(
      h => h !== handler
    );
  }

  private emit(event: string, data: unknown) {
    this.eventListeners[event]?.forEach(h => h(data));
    this.output?.emit?.({ type: event, data });
  }
}

// 싱글톤 인스턴스 export (이름 변경: transferService -> receiverService 의미로 사용되지만 호환성 위해 유지)
export const transferService = new ReceiverService();
