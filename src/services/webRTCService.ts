console.log('[webRTCService] ✅ [DEBUG] ARCHITECTURE FIXED:');
console.log(
  '[webRTCService] ✅ [DEBUG] - Now uses SinglePeerConnection (unified)'
);
console.log(
  '[webRTCService] ✅ [DEBUG] - Receiver-only service (Sender logic removed)'
);
console.log(
  '[webRTCService] ✅ [DEBUG] - Architecture unified with SwarmManager'
);

import { signalingService, TurnConfigResponse } from './signaling';
import { logInfo, logError, logWarn, logDebug } from '../utils/logger';
import { SinglePeerConnection, PeerConfig } from './singlePeerConnection';
import { CryptoService } from './cryptoService';

type EventHandler = (data: any) => void;

// Writer 인터페이스 정의
interface IFileWriter {
  initStorage(manifest: any): Promise<void>;
  writeChunk(packet: ArrayBuffer): Promise<void>;
  cleanup(): Promise<void>;
  onProgress(cb: (progress: number) => void): void;
  onComplete(cb: (actualSize: number) => void): void;
  onError(cb: (err: string) => void): void;
  // 🚀 [추가] 흐름 제어 인터페이스
  onFlowControl?(cb: (action: 'PAUSE' | 'RESUME') => void): void;
  // 🔐 [E2E] 암호화 키 설정
  setEncryptionKey?(sessionKey: Uint8Array, randomPrefix: Uint8Array): void;
}

class ReceiverService {
  // 연결 관리
  private peer: SinglePeerConnection | null = null;
  private roomId: string | null = null;

  // 파일 쓰기
  private writer: IFileWriter | null = null;

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
    signalingService.on('offer', this.handleOffer.bind(this));
    signalingService.on('ice-candidate', this.handleIceCandidate.bind(this));
    signalingService.on('room-full', () => {
      this.emit('room-full', 'Room is currently occupied. Please wait.');
    });
    // Receiver는 'answer'를 받을 일이 없음 (Answerer 역할이므로)
  }

  // ======================= PUBLIC API =======================

  public async initReceiver(roomId: string) {
    if (this.roomId === roomId && this.isConnected()) {
      console.log('[Receiver] Already connected to room:', roomId);
      return;
    }

    console.log('[Receiver] Initializing connection for room:', roomId);

    // 기존 연결 정리
    this.cleanup();
    this.roomId = roomId;

    try {
      // 1. 시그널링 연결
      await signalingService.connect();
      await signalingService.joinRoom(roomId);

      // 2. TURN 설정 요청 (Promise 저장)
      // 🚨 [수정] 요청을 시작하고 Promise를 멤버 변수에 저장합니다.
      this.turnConfigPromise = this.fetchTurnConfig(roomId);

      // 3. UI 상태 변경 전에 TURN 설정이 오거나, 최대 2초 기다림 (지연 최소화)
      // 이렇게 하면 Offer가 오기 전에 최대한 TURN 정보를 확보하려고 시도합니다.
      const timeoutPromise = new Promise<void>(resolve => setTimeout(resolve, 2000));
      await Promise.race([this.turnConfigPromise, timeoutPromise]);

      this.emit('status', 'CONNECTING');
    } catch (error: any) {
      logError('[Receiver]', 'Initialization failed:', error);
      this.emit('error', error.message || 'Initialization failed');
    }
  }

  public setWriter(writerInstance: IFileWriter) {
    if (this.writer) {
      this.writer.cleanup();
    }
    this.writer = writerInstance;

    // Writer 이벤트 연결
    this.writer.onProgress((progressData: any) => {
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
      this.emit('complete', { actualSize });
      this.notifyDownloadComplete();
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
  }

  /**
   * 저장소 준비 완료 후 수신 시작
   */
  public async startReceiving(manifest: any) {
    if (!this.writer) {
      this.emit('error', 'Storage writer not initialized');
      return;
    }

    try {
      console.log('[Receiver] Initializing storage writer...');
      await this.writer.initStorage(manifest);

      console.log('[Receiver] ✅ Storage ready. Sending TRANSFER_READY...');
      this.emit('storage-ready', true);
      this.emit('status', 'RECEIVING');

      // Sender에게 준비 완료 신호 전송
      if (this.peer && this.peer.connected) {
        this.peer.send(JSON.stringify({ type: 'TRANSFER_READY' }));
      } else {
        throw new Error('Peer disconnected during storage init');
      }
    } catch (error: any) {
      console.error('[Receiver] Storage init failed:', error);
      this.emit('error', error.message || 'Failed to initialize storage');
    }
  }

  public cleanup() {
    logInfo('[Receiver]', 'Cleaning up resources...');
    this.roomId = null;
    this.connectedPeerId = null;

    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }

    if (this.writer) {
      this.writer.cleanup();
      // writer는 null로 만들지 않음 (재사용 가능성 고려)
    }
  }

  // ======================= INTERNAL LOGIC =======================

  private isConnected(): boolean {
    return this.peer ? this.peer.connected : false;
  }

  private async fetchTurnConfig(roomId: string) {
    try {
      const response: TurnConfigResponse =
        await signalingService.requestTurnConfig(roomId);
      if (response.success && response.data) {
        this.iceServers = response.data.iceServers;
      }
    } catch (error) {
      // 실패 시 기본 STUN 사용
    }
  }

  /**
   * Sender로부터 Offer 수신 시 처리
   */
  private handleOffer = async (d: any) => {
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
      console.log('[Receiver] Waiting for TURN config before accepting offer...');
      try {
        await this.turnConfigPromise;
      } catch (e) {
        console.warn('[Receiver] TURN config failed, proceeding with default STUN');
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
    this.peer.signal(d.offer);
  };

  private handleIceCandidate = (d: any) => {
    if (this.connectedPeerId && d.from !== this.connectedPeerId) return;
    if (!this.peer || this.peer.isDestroyed()) return;

    this.peer.signal(d.candidate);
  };

  private setupPeerEvents(peer: SinglePeerConnection) {
    peer.on('signal', data => {
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
    });

    peer.on('data', this.handleData.bind(this));

    peer.on('error', err => {
      logError('[Receiver]', 'Peer error:', err);
      this.emit('error', err.message);
    });

    peer.on('close', () => {
      logInfo('[Receiver]', 'Peer connection closed');
      this.emit('error', 'Connection closed');
    });
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
        this.emit('error', 'Disk write failed');
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

  private notifyDownloadComplete() {
    if (this.peer && this.peer.connected) {
      const msg = JSON.stringify({ type: 'DOWNLOAD_COMPLETE' });
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

  private emit(event: string, data: any) {
    this.eventListeners[event]?.forEach(h => h(data));
  }
}

// 싱글톤 인스턴스 export (이름 변경: transferService -> receiverService 의미로 사용되지만 호환성 위해 유지)
export const transferService = new ReceiverService();
