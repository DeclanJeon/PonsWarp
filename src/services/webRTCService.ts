debugLog('[webRTCService] ✅ [DEBUG] ARCHITECTURE FIXED:');
debugLog(
  '[webRTCService] ✅ [DEBUG] - Now uses SinglePeerConnection (unified)'
);
debugLog(
  '[webRTCService] ✅ [DEBUG] - Receiver-only service (Sender logic removed)'
);
debugLog('[webRTCService] ✅ [DEBUG] - Architecture unified with SwarmManager');

import { TurnConfigResponse } from './signaling';
import { getSignalingService } from './signaling-factory';

// 팩토리를 통해 시그널링 서비스 가져오기
const signalingService = getSignalingService();
import {
  logInfo,
  logError,
  logWarn,
  logDebug,
  debugLog,
} from '../utils/logger';
import { SinglePeerConnection, PeerConfig } from './singlePeerConnection';
import { base64ToBytes, CryptoService } from './cryptoService';
import { TransferManifest } from '../types/types';
import { getErrorMessage } from '../utils/errors';

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
interface IFileWriter {
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
  // 🔐 [E2E] 암호화 키 설정
  setEncryptionKey?(sessionKey: Uint8Array, randomPrefix: Uint8Array): void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;

class ReceiverService {
  // 연결 관리
  private peer: SinglePeerConnection | null = null;
  private roomId: string | null = null;

  // 파일 쓰기
  private writer: IFileWriter | null = null;
  private currentManifest: TransferManifest | null = null;
  private isTransferActive = false;
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // 상태 관리
  private eventListeners: Record<string, EventHandler[]> = {};
  private connectedPeerId: string | null = null; // 연결된 Sender ID

  // ICE 서버 설정 (기본값)
  private iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
  ];

  // 🚨 [추가] TURN 설정 로딩 상태를 추적하기 위한 Promise
  private turnConfigPromise: Promise<void> | null = null;

  // 🔐 [E2E Encryption]
  private cryptoService: CryptoService | null = null;
  private encryptionEnabled: boolean = false;
  private sessionKey: Uint8Array | null = null;
  private randomPrefix: Uint8Array | null = null;

  // Bound Handlers
  private handleRoomFull = () => {
    this.emit('room-full', 'Room is currently occupied. Please wait.');
  };

  constructor() {
    this.setupSignalingHandlers();
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
    signalingService.on('offer', this.handleOffer);
    signalingService.on('ice-candidate', this.handleIceCandidate);
    signalingService.on('room-full', this.handleRoomFull);
    // Receiver는 'answer'를 받을 일이 없음 (Answerer 역할이므로)
  }

  private removeSignalingHandlers() {
    signalingService.off('offer', this.handleOffer);
    signalingService.off('ice-candidate', this.handleIceCandidate);
    signalingService.off('room-full', this.handleRoomFull);
  }

  // ======================= PUBLIC API =======================

  public async initReceiver(roomId: string) {
    if (this.roomId === roomId && this.isConnected()) {
      debugLog('[Receiver] Already connected to room:', roomId);
      return;
    }

    debugLog('[Receiver] Initializing connection for room:', roomId);

    // 기존 연결 정리 (Adapter의 연결은 끊지 않고 피어 상태만 정리)
    this.resetState();
    this.roomId = roomId;

    try {
      // 1. 시그널링 연결 (이미 연결되어 있다면 즉시 resolve됨)
      await signalingService.connect();

      // 2. 방 입장
      await signalingService.joinRoom(roomId);

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

  public setWriter(writerInstance: IFileWriter) {
    if (this.writer) {
      this.writer.cleanup();
    }
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
          speed: 0,
          bytesTransferred: 0,
          totalBytes: 0,
        });
      }
    });

    this.writer.onComplete(actualSize => {
      this.isTransferActive = false;
      this.isReconnecting = false;
      this.emit('complete', { actualSize });
      this.notifyDownloadComplete(actualSize);
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
    if (!this.writer) {
      this.emit('error', 'Storage writer not initialized');
      return;
    }

    try {
      debugLog('[Receiver] Initializing storage writer...');
      this.currentManifest = manifest;
      await this.writer.initStorage(manifest);

      debugLog('[Receiver] ✅ Storage ready. Sending TRANSFER_READY...');
      this.emit('storage-ready', true);
      this.emit('status', 'RECEIVING');
      this.isTransferActive = true;
      this.isReconnecting = false;
      this.reconnectAttempts = 0;

      // Sender에게 준비 완료 신호 전송. 일부 브라우저는 data channel open 직후
      // 첫 control frame을 조용히 누락시키는 경우가 있어 짧게 재전송한다.
      if (this.peer && this.peer.connected) {
        const readyMessage = JSON.stringify({ type: 'TRANSFER_READY' });
        [0, 100, 300, 1000].forEach(delay => {
          setTimeout(() => {
            this.peer?.send(readyMessage);
          }, delay);
        });
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
    logInfo('[Receiver]', 'Cleaning up resources (Full)...');
    this.resetState();
    this.removeSignalingHandlers();
  }

  private resetState() {
    logInfo('[Receiver]', 'Resetting state...');
    this.roomId = null;
    this.connectedPeerId = null;
    this.currentManifest = null;
    this.isTransferActive = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }

    if (this.writer) {
      this.writer.cleanup();
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
  }

  // ======================= INTERNAL LOGIC =======================

  private isConnected(): boolean {
    return this.peer ? this.peer.connected : false;
  }

  private async fetchTurnConfig(roomId: string) {
    try {
      const response = (await signalingService.requestTurnConfig(
        roomId
      )) as TurnConfigResponse;
      if (response?.success && response?.data) {
        this.iceServers = response.data.iceServers;
      }
    } catch (error) {
      // 실패 시 기본 STUN 사용
    }
  }

  /**
   * Sender로부터 Offer 수신 시 처리
   */
  private handleOffer = async (d: ReceiverSignalMessage) => {
    // 🔍 [DEBUG] SDP 매핑 확인
    debugLog('[Receiver] 🚨 [DEBUG] Offer data received:', {
      from: d.from,
      hasOffer: !!d.offer,
      hasSdp: !!d.sdp,
      offerType: typeof d.offer,
      sdpType: typeof d.sdp,
      fullData: d,
    });

    // 이미 연결된 Sender가 있다면 다른 요청 무시 (1:1 연결 유지)
    if (this.connectedPeerId && d.from !== this.connectedPeerId) {
      logWarn('[Receiver]', `Ignoring offer from unknown peer: ${d.from}`);
      return;
    }

    // 첫 연결인 경우 ID 기록
    if (!this.connectedPeerId) {
      this.connectedPeerId = d.from;
    }

    logInfo('[Receiver]', `Received offer from ${d.from}`);

    // 🚨 [추가] TURN 설정이 아직 로딩 중이라면 확실하게 기다립니다.
    if (this.turnConfigPromise) {
      debugLog('[Receiver] Waiting for TURN config before accepting offer...');
      try {
        await this.turnConfigPromise;
      } catch (e) {
        console.warn(
          '[Receiver] TURN config failed, proceeding with default STUN'
        );
      }
    }

    // 기존 Peer가 있다면 정리 (재연결 시나리오)
    if (this.peer) {
      this.peer.destroy();
    }

    // SinglePeerConnection 생성 (이제 this.iceServers에는 443 TURN 정보가 들어있음)
    const config: PeerConfig = { iceServers: this.iceServers };
    this.peer = new SinglePeerConnection(d.from, false, config);

    this.setupPeerEvents(this.peer);

    // 시그널링 처리
    if (d.offer) this.peer.signal(d.offer);
  };

  private handleIceCandidate = (d: ReceiverSignalMessage) => {
    if (this.connectedPeerId && d.from !== this.connectedPeerId) return;
    if (!this.peer || this.peer.isDestroyed()) return;

    if (d.candidate) this.peer.signal(d.candidate);
  };

  private setupPeerEvents(peer: SinglePeerConnection) {
    peer.on<PeerSignalData>('signal', data => {
      // Receiver는 Answer와 Candidate를 Sender에게 보냄
      if (data.type === 'answer') {
        signalingService.sendAnswer(this.roomId!, data, peer.id);
      } else if (data.candidate) {
        signalingService.sendCandidate(this.roomId!, data, peer.id);
      }
    });

    peer.on('connected', () => {
      logInfo('[Receiver]', 'P2P Channel Connected!');
      this.emit('connected', true);

      if (this.isReconnecting) {
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.emit('status', 'RECEIVING');
        this.emit('reconnected', true);
        this.writer?.requestResumeFromCurrentOffset?.(
          'connection restored after data channel close'
        );
      }
    });

    peer.on('data', this.handleData.bind(this));

    peer.on<Error>('error', err => {
      logError('[Receiver]', 'Peer error:', err);
      this.emit('error', getErrorMessage(err, 'Peer error'));
    });

    peer.on('close', () => {
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
      this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS
    );
  }

  private scheduleReconnect(): void {
    if (!this.roomId || this.reconnectTimer) {
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    this.connectedPeerId = null;

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * this.reconnectAttempts,
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
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      try {
        await signalingService.connect();

        try {
          await signalingService.leaveRoom(roomId);
        } catch {
          // Rejoin still has a chance to trigger a fresh offer.
        }

        await new Promise(resolve => setTimeout(resolve, 250));
        await signalingService.joinRoom(roomId);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;

          if (this.isReconnecting && this.shouldAttemptReconnect()) {
            this.scheduleReconnect();
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

  private handleData(data: ArrayBuffer) {
    // 1. 제어 메시지 (JSON 문자열)
    if (this.isControlMessage(data)) {
      this.handleControlMessage(data);
      return;
    }

    // 2. 파일 데이터 (Binary) -> Writer로 전달
    if (this.writer) {
      // Fire-and-forget 방식으로 쓰기 (블로킹 방지)
      this.writer.writeChunk(data).catch(err => {
        console.error('[Receiver] Write error:', err);
        this.emit(
          'error',
          err instanceof Error ? err.message : 'Disk write failed'
        );
      });
    }
  }

  private isControlMessage(data: ArrayBuffer): boolean {
    // 텍스트일 확률이 높은지 간단 체크 (첫 바이트가 '{' 인지 확인)
    // 완벽하진 않으나 프로토콜상 바이너리 헤더는 0x00으로 시작하지 않음 (FileIndex)
    if (data.byteLength > 0) {
      const view = new Uint8Array(data);
      return view[0] === 123; // '{' ASCII
    }
    return false;
  }

  private handleControlMessage(data: ArrayBuffer) {
    try {
      const str = new TextDecoder().decode(data);
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
      }
    } catch (e) {
      // JSON 파싱 실패는 무시 (바이너리 데이터일 수 있음)
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
        setTimeout(() => {
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
  }
}

// 싱글톤 인스턴스 export (이름 변경: transferService -> receiverService 의미로 사용되지만 호환성 위해 유지)
export const transferService = new ReceiverService();
