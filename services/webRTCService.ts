// import SimplePeer from 'simple-peer';
import SimplePeer from 'simple-peer/simplepeer.min.js';
import { signalingService } from './signaling';
import { getSenderWorkerV1, getReceiverWorkerV1 } from './workerFactory';
import { TransferManifest } from '../types';
import { errorHandler, ErrorType, ErrorSeverity } from './errorHandling';
import { logInfo, logWarn, logError, logCritical } from '../utils/logger';
// 상수로 관리되는 설정 import
import { CHUNK_SIZE_INITIAL, CHUNK_SIZE_MAX, MAX_BUFFERED_AMOUNT, LOW_WATER_MARK, SENDER_BATCH_SIZE } from '../constants';

type EventHandler = (data: any) => void;

interface ICEServers {
  urls: string[];
  username?: string;
  credential?: string;
}

class EnhancedWebRTCService {
  private peer: SimplePeer.Instance | null = null;
  private worker: Worker | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};
  private roomId: string | null = null;
  private iceServers: RTCIceServer[] = [];
  private turnCredentials: any = null;
  private turnRefreshInterval: NodeJS.Timeout | null = null;
  
  // 🚨 [수정] 상수로 변경하여 일관성 유지
  private readonly MAX_BUFFERED_AMOUNT = MAX_BUFFERED_AMOUNT;
  private readonly LOW_WATER_MARK = LOW_WATER_MARK;
  private isPaused = false;
  private isTransferring = false;
  private bufferCheckInterval: NodeJS.Timeout | null = null;
  
  // 🚀 [추가] 네트워크 모니터링 관련 변수
  private networkMonitorInterval: NodeJS.Timeout | null = null;
  
  // 🚨 [추가] 전송 큐 시스템
  private chunkQueue: Array<{chunk: ArrayBuffer, progressData: any}> = [];
  private isProcessingQueue = false;
  private isTransferCompleted = false; // 워커 생성 완료 플래그

  constructor() {
    signalingService.on('offer', this.handleOffer.bind(this));
    signalingService.on('answer', this.handleAnswer.bind(this));
    signalingService.on('ice-candidate', this.handleIceCandidate.bind(this));
    signalingService.on('peer-joined', this.handlePeerJoined.bind(this));
    
    // TURN 자동 새로고침 설정 (5분마다)
    this.startTurnRefreshInterval();
  }

  public async connectSignaling() {
    await signalingService.connect();
    // 시그널링 연결 후 TURN 설정 가져오기
    await this.initializeTurnServers();
  }

  // TURN 서버 초기화
  private async initializeTurnServers(): Promise<{ stun: boolean; turn: boolean; error?: string }> {
    try {
      const result = await errorHandler.executeWithRetry(
        async () => {
          logInfo('[WebRTC]', 'Initializing TURN servers...');
          
          // roomId가 없으면 현재 roomId 사용 또는 기본값 사용
          const roomId = this.roomId || 'default-room';
          const turnConfig = await signalingService.requestTurnConfig(roomId);
          
          if (turnConfig.success && turnConfig.data && turnConfig.data.iceServers) {
            this.iceServers = turnConfig.data.iceServers;
            this.turnCredentials = turnConfig.data;
            logInfo('[WebRTC]', 'TURN servers configured successfully', {
              servers: this.iceServers.length,
              hasTurn: this.iceServers.some(server => Array.isArray(server.urls) && server.urls.some(url => url.includes('turn')))
            });
            return { stun: true, turn: true };
          } else {
            throw new Error('Failed to get TURN configuration');
          }
        },
        ErrorType.TURN_CONNECTION_FAILED,
        { operation: 'initializeTurnServers' }
      );

      if (result.success && result.result) {
        return result.result;
      } else {
        return {
          stun: false,
          turn: false,
          error: result.error?.message || 'Failed to initialize TURN servers'
        };
      }
    } catch (error) {
      return {
        stun: false,
        turn: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // TURN 자동 새로고침
  private startTurnRefreshInterval() {
    // 5분마다 TURN 자격 증명 새로고침
    this.turnRefreshInterval = setInterval(async () => {
      if (this.turnCredentials && this.turnCredentials.ttl) {
        const now = Date.now();
        const expiryTime = this.turnCredentials.ttl * 1000; // TTL을 밀리초로 변환
        
        // 만료 1분 전에 새로고침
        if (now + 60000 >= expiryTime) {
          logInfo('[WebRTC]', 'Refreshing TURN credentials...');
          
          const result = await this.initializeTurnServers();
          
          if (!result.stun && !result.turn) {
            logError('[WebRTC]', 'Failed to refresh TURN credentials', { error: result.error });
            // 에러 콜백 등록
            errorHandler.onError(ErrorType.TURN_CREDENTIALS_EXPIRED, (errorInfo) => {
              logInfo('[WebRTC]', 'TURN refresh failed, suggestions', errorHandler.suggestFallback(errorInfo));
            });
          }
        }
      }
    }, 60000); // 1분마다 체크
  }

  // TURN 수동 새로고침
  public async refreshTurnServers(): Promise<{ stun: boolean; turn: boolean; error?: string }> {
    return await this.initializeTurnServers();
  }

  public generateRoomId(): string {
    this.roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    return this.roomId;
  }

  public async joinRoom(roomId: string) {
    if (this.roomId && this.roomId !== roomId) {
      await signalingService.leaveRoom(this.roomId);
    }
    this.roomId = roomId;
    await signalingService.joinRoom(roomId);
  }

  // ======================= SENDER LOGIC =======================

  public async initSender(manifest: TransferManifest, files: File[], roomId: string) {
    logInfo('[Sender]', 'Initializing with Queue System');
    this.cleanup();

    this.roomId = roomId;
    await this.connectSignaling();
    await this.joinRoom(roomId);

    // 🚨 [추가] 큐 초기화
    this.chunkQueue = [];
    this.isProcessingQueue = false;
    this.isTransferCompleted = false;

    this.worker = getSenderWorkerV1();
    
    // 워커 이벤트 핸들러
    this.worker.onmessage = (e) => {
      const { type, payload } = e.data;

      if (type === 'ready') {
        // 🚨 [수정] Worker 초기화 시 청크 사이즈 제한 설정 전달
        this.worker!.postMessage({
          type: 'init',
          payload: {
            files,
            manifest,
            config: {
              startChunkSize: CHUNK_SIZE_INITIAL,
              maxChunkSize: CHUNK_SIZE_MAX
            }
          }
        });
        
      }
      else if (type === 'chunk-ready') {
        // 🚨 [핵심 변경] 즉시 전송하지 않고 큐에 넣음
        this.chunkQueue.push({
            chunk: payload.chunk,
            progressData: payload.progressData
        });
        
        // 큐 처리기가 놀고 있으면 깨움
        if (!this.isProcessingQueue) {
            this.processChunkQueue();
        }
      }
      else if (type === 'complete') {
        // 워커는 다 만들었음. 이제 큐가 비워지길 기다림.
        this.isTransferCompleted = true;
        // 큐 처리기가 멈춰있다면(혹은 비어있다면) 완료 체크 시도
        if (!this.isProcessingQueue && this.chunkQueue.length === 0) {
            this.finishTransfer();
        }
      }
      else if (type === 'error') {
        this.emit('error', payload.error);
      }
    };

    // Peer 연결 대기 중 상태
    this.emit('status', 'WAITING_FOR_PEER');
    
    // Manifest 저장을 위해 임시 보관 (Peer 연결 후 전송)
    this.pendingManifest = manifest;
  }

  private pendingManifest: TransferManifest | null = null;

  // 실제 전송 시작 (Peer 연결 후)
  private startTransferSequence() {
    if (!this.peer || !this.pendingManifest) return;

    logInfo('[Sender]', 'Sending Manifest...');
    const manifestStr = JSON.stringify({
      type: 'MANIFEST',
      manifest: this.pendingManifest
    });
    this.peer.send(manifestStr);

    // 잠시 대기 후 바이너리 스트림 시작 (수신측 준비 시간 고려)
    setTimeout(() => {
      logInfo('[Sender]', 'Starting Binary Stream...');
      this.isTransferring = true;
      this.worker?.postMessage({ type: 'start' });
      this.emit('status', 'TRANSFERRING');
    }, 500);
  }

  // 🔥 [최적화 3] 큐 처리기 가속
  private async processChunkQueue() {
    if (this.isProcessingQueue || !this.peer) return;
    this.isProcessingQueue = true;

    // @ts-ignore
    const channel = this.peer._channel as RTCDataChannel;

    while (this.chunkQueue.length > 0) {
        if (!this.peer || !channel || channel.readyState !== 'open') {
            this.isProcessingQueue = false;
            return;
        }

        // 1. 버퍼 체크 (가속화)
        if (channel.bufferedAmount > this.MAX_BUFFERED_AMOUNT) {
            // 🚀 [최적화] 10ms -> 1ms (브라우저 최소 틱) 또는 requestAnimationFrame
            // 버퍼가 찰 때만 잠시 쉼.
            await new Promise(resolve => setTimeout(resolve, 1));
            continue;
        }

        const item = this.chunkQueue.shift();
        if (!item) break;

        try {
            this.peer.send(item.chunk);
            this.emit('progress', item.progressData);
            
            // 🚀 [최적화 2 대응] Backpressure 로직 수정
            // 큐가 비어갈 때 '한 번' 요청하면 워커가 '5개(Batch)'를 보내줍니다.
            // 따라서 너무 자주 요청하지 않도록 임계값을 낮춥니다.
            // 🚨 [수정] 레이스 컨디션 방지를 위해 더 보수적인 임계값 사용
            if (this.chunkQueue.length < 5) {
                this.worker?.postMessage({ type: 'pull' });
            }

        } catch (e) {
            logWarn('[Sender]', 'Send retry...', e);
            this.chunkQueue.unshift(item);
            // 에러 시에는 조금 더 쉬어줌
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }

    this.isProcessingQueue = false;

    if (this.isTransferCompleted && this.chunkQueue.length === 0) {
        this.finishTransfer();
    }
  }

  // 🔥 [수정] 완료 처리 (ACK 대기 포함)
  private async finishTransfer() {
    logInfo('[Sender]', 'Queue drained. Finalizing transfer...');

    // 1. WebRTC 내부 버퍼가 완전히 0이 될 때까지 대기
    await this.waitForBufferZero();
    
    // 2. 네트워크 안정화 대기 (중요)
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 3. EOS 패킷 전송
    const eosPacket = new ArrayBuffer(6);
    const view = new DataView(eosPacket);
    view.setUint16(0, 0xFFFF, true);
    view.setUint32(2, 0, true);

    logInfo('[Sender]', 'Sending EOS packet. Waiting for ACK...');
    
    try {
      this.peer?.send(eosPacket);
      
      // 4. ACK 타임아웃 설정 (30초)
      setTimeout(() => {
          if (this.isTransferring) {
              logWarn('[Sender]', 'ACK timeout. Closing.');
              this.emit('complete', true);
              this.isTransferring = false;
          }
      }, 30000);

    } catch (error) {
      logError('[Sender]', 'Failed to send EOS:', error);
      this.emit('complete', true);
    }
  }

  // 🚨 [추가] 청크 ID 생성기
  private chunkIdCounter = 0;
  private generateChunkId(): string {
    return `chunk_${++this.chunkIdCounter}_${Date.now()}`;
  }

  // 🚨 [추가] 실패한 청크 추적
  private failedChunks: Array<{
    chunkId: string;
    size: number;
    error: string;
    retryCount: number;
  }> = [];

  // 🔥 [신규] 버퍼가 비워지길 기다렸다가 워커 재개
  private waitForBufferDrain() {
    // 기존 인터벌이 있다면 정리
    if (this.bufferCheckInterval) {
      clearInterval(this.bufferCheckInterval);
    }

    this.bufferCheckInterval = setInterval(() => {
      // @ts-ignore
      const channel = this.peer?._channel as RTCDataChannel;
      
      if (!channel || !channel.readyState || channel.readyState !== 'open') {
        clearInterval(this.bufferCheckInterval!);
        this.bufferCheckInterval = null;
        return;
      }

      // 버퍼가 충분히 비워졌으면 재개
      if (channel.bufferedAmount <= this.LOW_WATER_MARK) {
        clearInterval(this.bufferCheckInterval!);
        this.bufferCheckInterval = null;
        this.isPaused = false;
        // logInfo('[Sender]', `Buffer drained (${channel.bufferedAmount} bytes), resuming worker`);
        // 다시 데이터 달라고 요청
        this.worker?.postMessage({ type: 'pull' });
      }
    }, 5); // 5ms 간격 체크
  }


  // 🚨 버퍼가 0이 될 때까지 대기하는 함수
  private waitForBufferZero(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        // @ts-ignore
        const channel = this.peer?._channel as RTCDataChannel;
        
        if (!channel || !channel.readyState || channel.readyState !== 'open') {
          resolve();
          return;
        }

        // 0바이트가 될 때까지 엄격하게 체크
        if (channel.bufferedAmount === 0) {
          resolve();
        } else {
          // console.log(`[Sender] Draining buffer: ${channel.bufferedAmount} bytes left...`);
          setTimeout(check, 50); // 50ms 간격 폴링
        }
      };
      check();
    });
  }

  // ======================= RECEIVER LOGIC =======================

  public async initReceiver(roomId: string) {
    logInfo('[Receiver]', 'Initializing...');
    this.cleanup();

    this.roomId = roomId;
    await this.connectSignaling();
    await this.joinRoom(roomId);

    this.worker = getReceiverWorkerV1();

    this.worker.onmessage = (e) => {
      const { type, payload } = e.data;

      if (type === 'progress') {
        this.emit('progress', payload);
      }
      else if (type === 'complete') {
        // 🚨 [추가] 무결성 검증이 끝났으므로 Sender에게 ACK 전송
        logInfo('[Receiver]', 'Integrity verified. Sending ACK to Sender.');
        
        try {
            if (this.peer && !this.peer.destroyed) {
                const ackMsg = JSON.stringify({ type: 'ACK_COMPLETE' });
                this.peer.send(ackMsg);
            }
        } catch (err) {
            logWarn('[Receiver]', 'Failed to send ACK:', err);
        }

        // 기존 완료 처리
        this.emit('complete', payload);
      }
      else if (type === 'error') {
        this.emit('error', payload.error);
      }
    };

    this.emit('status', 'CONNECTING');
  }

  // ======================= PEER HANDLING =======================

  private async createPeer(initiator: boolean) {
    // Peer 생성 전에 TURN 서버 설정 확인
    if (this.iceServers.length === 0) {
      logWarn('[WebRTC]', 'No ICE servers configured, using fallback');
      this.iceServers = [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
      ];
    }

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: {
        iceServers: this.iceServers,
        // ICE 연결 최적화 설정
        iceCandidatePoolSize: 10, // 0 -> 10으로 변경 (연결 속도 향상)
        iceTransportPolicy: 'all' // 모든 타입의 ICE 후보 사용 (relay가 아닌 host/srflx 우선)
      },
      // 🚨 [수정] 데이터 채널 설정 최적화
      channelConfig: {
        ordered: true, // 순서 보장 (필수)
        // 🚨 [삭제] maxRetransmits: 3  <-- 이 줄을 반드시 삭제해야 합니다!
        // 이 옵션이 있으면 네트워크 혼잡 시 데이터를 버립니다.
        // 삭제하면 'Reliable Mode'가 되어 데이터가 100% 도착할 때까지 재전송합니다.
        protocol: 'file-transfer' // 프로토콜 식별자
      },
      // 🚨 [수정] SCTP 설정 최적화
      // maxMessageSize는 반드시 CHUNK_SIZE_MAX (64KB)보다 커야 함 (헤더 포함 고려)
      sctpConfig: {
        maxMessageSize: 262144, // 256KB
        // 🚀 [최적화] 버퍼 크기를 더 키워 고속 전송 시 드랍 방지
        sendBufferSize: 16 * 1024 * 1024, // 16MB
        receiveBufferSize: 16 * 1024 * 1024 // 16MB
      }
    });

    logInfo('[WebRTC]', 'Creating peer with ICE servers', {
      initiator,
      iceServerCount: this.iceServers.length,
      hasTurn: this.iceServers.some(server => Array.isArray(server.urls) && server.urls.some(url => url.includes('turn')))
    });

    peer.on('signal', (data) => {
      if ('candidate' in data) signalingService.sendCandidate(this.roomId!, data);
      else if (data.type === 'offer') signalingService.sendOffer(this.roomId!, data);
      else if (data.type === 'answer') signalingService.sendAnswer(this.roomId!, data);
    });

    peer.on('connect', () => {
      logInfo(`[${initiator ? 'Sender' : 'Receiver'}]`, 'Connected!');
      this.emit('connected', true);
      if (initiator) {
        this.startTransferSequence();
        // 🚀 [신규] 네트워크 모니터링 시작 (송신측만)
        this.startNetworkMonitoring();
      }
    });

    peer.on('data', (data) => this.handleReceivedData(data));
    peer.on('error', (err) => {
      logError('[WebRTC]', 'Peer error:', err);
      // 🚨 [추가] 전송 중단 플래그 설정
      this.isTransferring = false;
      this.emit('error', err.message || 'Unknown peer error');
    });
    peer.on('close', () => {
      logWarn('[WebRTC]', 'Peer connection closed');
      // 🚨 [추가] 전송 중단 플래그 설정
      this.isTransferring = false;
      this.emit('error', 'Peer connection closed');
    });

    this.peer = peer;
  }

  private handleReceivedData(data: any) {
    // 1. JSON 처리 (MANIFEST 및 ACK 처리)
    if (typeof data === 'string' || (data instanceof Uint8Array && data[0] === 123)) { // '{' char code
      try {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        
        // 🚨 [추가] ACK 메시지 처리 (Sender 측 로직)
        if (text.includes('"type":"ACK_COMPLETE"')) {
            logInfo('[Sender]', '✅ ACK received from Receiver. Closing connection.');
            this.emit('complete', true);
            this.isTransferring = false;
            return;
        }

        if (text.indexOf('MANIFEST') > 0) {
            const msg = JSON.parse(text);
            if (msg.type === 'MANIFEST') {
              logInfo('[Receiver]', '📜 Manifest Received', msg.manifest);
              this.emit('metadata', msg.manifest);
              this.worker?.postMessage({
                type: 'init-manifest',
                payload: msg.manifest
              });
              return;
            }
        }
        // 🚨 JSON EOF 처리는 삭제함 (바이너리로 통합)
      } catch (e) {}
    }

    // 2. 바이너리 데이터 처리
    if (this.worker) {
        let chunk: ArrayBuffer;
        if (data instanceof Uint8Array) {
            chunk = data.slice().buffer;
        } else if (data instanceof ArrayBuffer) {
            chunk = data;
        } else {
            return;
        }

        // 워커에게 그대로 토스 (워커가 0xFFFF를 감지할 것임)
        this.worker.postMessage({ type: 'chunk', payload: chunk }, [chunk]);
    }
  }

  // ... 기존 이벤트 핸들러들 ...
  private handlePeerJoined = async () => {
     if (this.pendingManifest && !this.peer) await this.createPeer(true);
  };
  private handleOffer = async (data: any) => {
     if (!this.peer) await this.createPeer(false);
     this.peer!.signal(data.offer);
  };
  private handleAnswer = async (data: any) => {
     if (this.peer) this.peer.signal(data.answer);
  };
  private handleIceCandidate = (data: any) => {
     if (this.peer) this.peer.signal(data.candidate);
  };

  public on(event: string, handler: EventHandler) {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(handler);
  }
  public off(event: string, handler: EventHandler) {
    if (!this.eventListeners[event]) return;
    this.eventListeners[event] = this.eventListeners[event].filter(h => h !== handler);
  }
  private emit(event: string, data: any) {
    this.eventListeners[event]?.forEach(h => h(data));
  }
  // 🚀 [신규] 네트워크 상태 모니터링 및 피드백 루프
  private startNetworkMonitoring() {
    // 기존 인터벌 정리
    if (this.networkMonitorInterval) {
      clearInterval(this.networkMonitorInterval);
    }

    this.networkMonitorInterval = setInterval(() => {
      if (!this.peer || !this.worker) return;
      
      // @ts-ignore
      const channel = this.peer._channel as RTCDataChannel;
      if (channel && channel.readyState && channel.readyState === 'open') {
        
        // 워커에게 현재 버퍼 상태 보고
        this.worker.postMessage({
          type: 'network-update',
          payload: {
            bufferedAmount: channel.bufferedAmount,
            maxBufferedAmount: this.MAX_BUFFERED_AMOUNT
          }
        });

        // 강력한 Backpressure: 버퍼가 너무 높으면 워커 일시 중지 로직은 유지
        // (하지만 워커가 스스로 크기를 줄이므로 이 빈도는 줄어들 것임)
        if (channel.bufferedAmount > this.MAX_BUFFERED_AMOUNT * 0.8) {
          logWarn('[Sender]', `Buffer very high (${channel.bufferedAmount} bytes), consider reducing chunk size`);
        }
      }
    }, 50); // 50ms 간격으로 더 자주 체크하여 반응성 향상
  }

  public cleanup() {
    if (this.peer) { this.peer.destroy(); this.peer = null; }
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.isPaused = false;
    this.isTransferring = false;
    this.pendingManifest = null;
    
    // 🚨 [추가] 실패한 청크 정보 정리
    if (this.failedChunks.length > 0) {
      logWarn('[Sender]', `Cleaning up ${this.failedChunks.length} failed chunks`, this.failedChunks);
      this.failedChunks = [];
    }
    
    // 🚨 [추가] 청크 ID 카운터 리셋
    this.chunkIdCounter = 0;
    
    // 버퍼 체크 인터벌 정리
    if (this.bufferCheckInterval) {
      clearInterval(this.bufferCheckInterval);
      this.bufferCheckInterval = null;
    }
    
    // 🚀 [추가] 네트워크 모니터링 인터벌 정리
    if (this.networkMonitorInterval) {
      clearInterval(this.networkMonitorInterval);
      this.networkMonitorInterval = null;
    }
    
    // 🚨 [추가] 큐 시스템 초기화
    this.chunkQueue = [];
    this.isProcessingQueue = false;
    this.isTransferCompleted = false;
    
    // TURN 새로고침 인터벌 정리
    if (this.turnRefreshInterval) {
      clearInterval(this.turnRefreshInterval);
      this.turnRefreshInterval = null;
    }
  }

  // TURN 연결 상태 확인
  public getTurnStatus() {
    return {
      hasTurnServers: this.iceServers.some(server => Array.isArray(server.urls) && server.urls.some(url => url.includes('turn'))),
      iceServerCount: this.iceServers.length,
      turnCredentials: this.turnCredentials ? {
        hasCredentials: !!(this.turnCredentials.username && this.turnCredentials.credential),
        ttl: this.turnCredentials.ttl,
        expiresAt: this.turnCredentials.ttl ? new Date(this.turnCredentials.ttl * 1000).toISOString() : null
      } : null
    };
  }

  // P2P 연결 실패 핸들링
  private async handlePeerConnectionFailure(errorInfo: any): Promise<void> {
    logError('[WebRTC]', 'Handling peer connection failure', { error: errorInfo });
    
    // 네트워크 상태 확인
    const networkStatus = await errorHandler.checkNetworkConnectivity();
    logInfo('[WebRTC]', 'Network status', networkStatus);
    
    // TURN 서버 상태 확인
    const turnStatus = this.getTurnStatus();
    logInfo('[WebRTC]', 'TURN status', turnStatus);
    
    // 폴백 제안 생성
    const suggestions = errorHandler.suggestFallback(errorInfo);
    logInfo('[WebRTC]', 'Fallback suggestions', suggestions);
    
    // TURN 서버 재설정 시도
    if (!networkStatus.turnReachable && turnStatus.hasTurnServers) {
      logInfo('[WebRTC]', 'Attempting to refresh TURN servers...');
      await this.refreshTurnServers();
    }
    
    // 에러 이벤트 발생
    this.emit('connection-failed', {
      error: errorInfo,
      networkStatus,
      turnStatus,
      suggestions
    });
  }

  // ICE 연결 품질 테스트
  public async testIceConnectivity(): Promise<{
    stun: boolean;
    turn: boolean;
    error?: string;
  }> {
    try {
      const result = await errorHandler.executeWithRetry(
        async () => {
          const testPeer = new SimplePeer({
            initiator: true,
            config: { iceServers: this.iceServers },
            trickle: false
          });

          return new Promise<{ stun: boolean; turn: boolean }>((resolve, reject) => {
            let stunConnected = false;
            let turnConnected = false;

            const timeout = setTimeout(() => {
              testPeer.destroy();
              reject(new Error('Connection test timeout'));
            }, 10000); // 10초 타임아웃

            testPeer.on('iceStateChange', (state) => {
              logInfo('[WebRTC]', 'ICE state', { state });
              
              if (state === 'connected' || state === 'completed') {
                clearTimeout(timeout);
                
                // ICE 후보 분석으로 STUN/TURN 연결 확인
                testPeer.on('iceCandidate', (candidate) => {
                  if (candidate) {
                    const candidateStr = candidate.candidate;
                    if (candidateStr.includes('typ relay')) {
                      turnConnected = true;
                    } else if (candidateStr.includes('typ srflx') || candidateStr.includes('typ prflx')) {
                      stunConnected = true;
                    }
                  }
                });

                setTimeout(() => {
                  testPeer.destroy();
                  resolve({ stun: stunConnected, turn: turnConnected });
                }, 2000);
              }
            });

            testPeer.on('error', (error) => {
              clearTimeout(timeout);
              testPeer.destroy();
              reject(error);
            });

            // 더미 offer 생성으로 ICE 연결 시작
            testPeer.createOffer();
          });
        },
        ErrorType.STUN_CONNECTION_FAILED,
        { operation: 'testIceConnectivity', iceServerCount: this.iceServers.length }
      );

      if (result.success && result.result) {
        return result.result;
      } else {
        return {
          stun: false,
          turn: false,
          error: result.error?.message || 'Unknown error'
        };
      }
    } catch (error) {
      return {
        stun: false,
        turn: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

export const transferService = new EnhancedWebRTCService();
