import { signalingService, TurnConfigResponse } from './signaling';
import { getSenderWorkerV1 } from './workerFactory';
import { TransferManifest } from '../types/types';
import { logInfo, logError } from '../utils/logger';
import {
  HEADER_SIZE,
  MAX_BUFFERED_AMOUNT,
  HIGH_WATER_MARK,
  BATCH_SIZE_MAX
} from '../utils/constants';
import { networkController } from './networkAdaptiveController';
import { SinglePeerConnection } from './singlePeerConnection';
import { setStatus } from './storeConnector'; // 🚀 Store 직접 제어
import { toast } from '../store/toastStore'; // 🚀 Toast 기능
import { formatBytes } from '../utils/fileUtils'; // 🚀 Import formatBytes

type EventHandler = (data: any) => void;

interface IFileWriter {
  initStorage(manifest: any, encryptionKey?: string): Promise<void>;
  writeChunk(packet: ArrayBuffer): Promise<void>;
  cleanup(): Promise<void>;
  onProgress(cb: (progress: any) => void): void;
  onComplete(cb: (actualSize: number) => void): void;
  onError(cb: (err: string) => void): void;
}

class EnhancedWebRTCService {
  private peer: SinglePeerConnection | null = null;
  private worker: Worker | null = null;
  private writer: IFileWriter | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};
  private roomId: string | null = null;
  private isTransferring = false;
  private isSender = false;
  private connectedPeerId: string | null = null;
  
  // Backpressure 제어 변수
  private isProcessingBatch = false;
  private pendingManifest: TransferManifest | null = null;
  private lastProgressSaveTime: number = 0;
  
  // 🚀 [적응형 제어] 컨트롤러 연결
  private networkController = networkController;
  
  // 파일 저장
  private files: File[] = []; // initSender에서 받은 파일 저장
  
  private iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  constructor() {
    this.setupSignalingHandlers();
  }

  private setupSignalingHandlers() {
    signalingService.on('offer', this.handleOffer.bind(this));
    signalingService.on('answer', this.handleAnswer.bind(this));
    signalingService.on('ice-candidate', this.handleIceCandidate.bind(this));
    signalingService.on('peer-joined', this.handlePeerJoined.bind(this));
    signalingService.on('room-full', () => {
        this.emit('room-full', 'Room is currently occupied.');
    });
  }

  public async connectSignaling() { await signalingService.connect(); }
  public async joinRoom(roomId: string) { this.roomId = roomId; await signalingService.joinRoom(roomId); }

  // ======================= SENDER LOGIC =======================

  public async initSender(manifest: TransferManifest, files: File[], roomId: string) {
    logInfo('[Sender]', 'Initializing Sender (Simplified Flow Control)');
    this.cleanup();
    this.isSender = true;
    this.roomId = roomId;
    this.files = files; // 🚀 파일 저장
    
    // Metrics 초기화
    this.networkController.start(manifest.totalSize);

    await this.connectSignaling();
    await this.joinRoom(roomId);
    await this.fetchTurnConfig(roomId);

    this.worker = getSenderWorkerV1();
    
    this.worker.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === 'ready') {
        this.worker!.postMessage({ type: 'init', payload: { files, manifest } });
      }
      else if (type === 'init-complete') {
        this.emit('worker-ready', true);
      }
      else if (type === 'error') {
        this.emit('error', payload.message);
      }
      else if (type === 'chunk-batch') this.handleBatchFromWorker(payload);
      else if (type === 'complete') this.finishTransfer();
    };

    this.emit('status', 'WAITING_FOR_PEER');
    this.pendingManifest = manifest;
  }

  // 🚀 [Step 12] 단순화된 배치 처리
  private async handleBatchFromWorker(payload: any) {
    // 🚀 [추가] 연결 중이거나 피어가 없으면 데이터 즉시 폐기 (CPU 절약)
    if (!this.peer || !this.peer.connected || this.peer.getBufferedAmount() > MAX_BUFFERED_AMOUNT) {
        // console.log('[Sender] 🗑️ Dropping batch (No peer or congestion)');
        this.isProcessingBatch = false;
        return;
    }
    
    const { chunks } = payload;
    const batchBytes = chunks.reduce((sum: number, c: ArrayBuffer) => sum + c.byteLength, 0);
    
    this.isProcessingBatch = false;

    try {
        // 1. Hard Backpressure: 버퍼가 꽉 찼으면, 비워질 때까지 여기서 대기 (Blocking)
        // 브라우저 메모리 폭주를 막는 최후의 보루
        if (this.peer.getBufferedAmount() + batchBytes > MAX_BUFFERED_AMOUNT) {
            await this.waitForBufferDrain();
        }

        // 2. 전송 (Burst)
        for (let i = 0; i < chunks.length; i++) {
            this.peer.send(chunks[i]);
            this.networkController.recordSend(chunks[i].byteLength);
        }
        
        // 3. 🚀 [핵심 요구사항] 진행률/속도가 실제 데이터 전송과 정확히 일치해야 함
        const metrics = this.networkController.getMetrics();
        const actualProgress = metrics.totalBytes > 0 
            ? Math.min((metrics.bytesSent / metrics.totalBytes) * 100, 100)
            : 0;
        
        this.emit('progress', {
            progress: actualProgress,
            speed: metrics.speed,
            bytesTransferred: metrics.bytesSent,
            totalBytesSent: metrics.bytesSent, // 호환성
            totalBytes: metrics.totalBytes,
            networkMetrics: metrics // 디버깅용
        });

        // 4. Greedy Refill: 버퍼에 여유가 생기면 즉시 다음 배치 요청
        // 이벤트 기반이므로 여기서 재귀 호출처럼 동작하여 끊김 없는 스트림 형성
        if (this.peer.getBufferedAmount() < HIGH_WATER_MARK) {
            this.requestMoreChunks();
        }

    } catch (e) {
        console.error('[Sender] Batch error:', e);
        this.cleanup();
    }
  }

  private async waitForBufferDrain(): Promise<void> {
    // 5ms 단위로 폴링하며 버퍼가 절반 이하로 떨어질 때까지 대기
    const checkInterval = 5;
    const targetLevel = MAX_BUFFERED_AMOUNT * 0.5;

    while (this.peer && this.peer.getBufferedAmount() > targetLevel) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      if (!this.peer.connected) return;
    }
  }

  private requestMoreChunks() {
    // 이미 워커가 일하고 있거나, 전송 중이 아니면 스킵
    if (this.isProcessingBatch || !this.worker || !this.isTransferring) return;
    
    this.isProcessingBatch = true;
    
    // 🚀 [적응형 제어] 컨트롤러가 계산한 최적의 배치 크기 요청
    const nextBatchSize = this.networkController.getRecommendedBatchSize();
    
    // 로그가 너무 많으면 제거하세요 (디버깅용)
    // console.log(`[Sender] Requesting dynamic batch: ${nextBatchSize}`);
    
    this.worker.postMessage({
        type: 'process-batch',
        payload: { count: nextBatchSize }
    });
  }

  private async finishTransfer() {
    this.isTransferring = false;
    await this.waitForBufferZero();
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const eosPacket = new ArrayBuffer(HEADER_SIZE);
    const view = new DataView(eosPacket);
    view.setUint16(0, 0xFFFF, true);
    
    this.peer?.send(eosPacket);
    logInfo('[Sender]', 'EOS sent');
    this.emit('remote-processing', true);
  }

  private waitForBufferZero(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.peer || this.peer.getBufferedAmount() === 0) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  // ======================= RECEIVER LOGIC =======================

  public async initReceiver(roomId: string) {
    if (this.roomId === roomId && !this.isSender) return;
    if (this.roomId && this.roomId !== roomId) this.cleanup();
    
    this.isSender = false;
    this.roomId = roomId;

    await this.connectSignaling();
    await this.joinRoom(roomId);
    this.fetchTurnConfig(roomId).catch(err => console.warn('TURN config failed', err));

    this.emit('status', 'CONNECTING');
  }

  public setWriter(writerInstance: IFileWriter) {
    if (this.writer) this.writer.cleanup();
    this.writer = writerInstance;

    this.writer.onProgress((progressData) => {
      const data = typeof progressData === 'object' ? progressData : { progress: progressData };
      this.emit('progress', data);
      
    });
    this.writer.onComplete((actualSize) => {
      this.emit('complete', { actualSize });
      this.notifyDownloadComplete();
    });
    this.writer.onError((err) => this.emit('error', err));
    
    // 🚀 [신규] NACK 이벤트 핸들링 (Writer -> Service -> Peer)
    // DirectFileWriter가 ReorderingBuffer의 onNack을 노출해야 함
    if ('onNack' in writerInstance) {
        (writerInstance as any).onNack((nack: any) => {
            console.warn('[Receiver] 🚨 Sending NACK for offset:', nack.offset);
            this.peer?.send(JSON.stringify({
                type: 'NACK',
                offset: nack.offset
            }));
        });
    }
  }

  // ======================= RECEIVER LOGIC =======================

  // Manifest 수신 시 호출됨 (기존 handleData 내부 로직 대체/보강)
  private async handleMetadata(manifest: TransferManifest) {
    console.log('[webRTCService] 📋 Metadata received:', {
      transferId: manifest.transferId,
      totalSize: manifest.totalSize,
      isSender: this.isSender
    });
    
    this.emit('metadata', manifest);
    this.pendingManifest = manifest;
    
    console.log('[webRTCService] ✨ Starting fresh transfer');
  }

  /**
   * 수신 시작
   */
  public async startReceiving(manifest: any, encryptionKeyStr?: string) {
    if (!this.writer) {
      console.error('[webRTCService] ❌ startReceiving: No writer set!');
      return;
    }
    try {
      console.log('[webRTCService] 📥 startReceiving called, initializing storage...');
      await this.writer.initStorage(manifest, encryptionKeyStr);
      this.emit('storage-ready', true);
      this.emit('status', 'RECEIVING');
      
      // 🚀 [핵심] TRANSFER_READY 메시지 전송
      console.log('[webRTCService] 📤 Sending TRANSFER_READY to sender...', {
        peerExists: !!this.peer,
        peerConnected: this.peer?.connected
      });
      
      if (this.peer && this.peer.connected) {
        this.peer.send(JSON.stringify({ type: 'TRANSFER_READY' }));
        console.log('[webRTCService] ✅ TRANSFER_READY sent successfully!');
      } else {
        console.error('[webRTCService] ❌ Cannot send TRANSFER_READY - peer not connected!');
      }
    } catch (error: any) {
      console.error('[webRTCService] ❌ startReceiving error:', error);
      this.emit('error', error.message);
    }
  }

  private async fetchTurnConfig(roomId: string) {
    try {
      const response: TurnConfigResponse = await signalingService.requestTurnConfig(roomId);
      if (response.success && response.data) this.iceServers = response.data.iceServers;
    } catch (error) {}
  }

  // ======================= SENDER LOGIC =======================

  private startWorkerTransfer() {
      if (!this.worker || !this.pendingManifest) return;
      
      // 워커에게 초기화 명령 전달
      this.worker.postMessage({
          type: 'init',
          payload: {
              files: this.files,
              manifest: this.pendingManifest
          }
      });
      
      this.isTransferring = true;
      this.requestMoreChunks();
      this.emit('status', 'TRANSFERRING');
  }

  // ======================= PEER HANDLING =======================

  private async createPeer(initiator: boolean) {
    try {
        const peer = new SinglePeerConnection(
            this.connectedPeerId || 'unknown',
            initiator,
            {
                iceServers: this.iceServers,
                isInitiator: initiator,
                id: this.connectedPeerId || 'unknown'
            }
        );

        peer.on('signal', data => {
            const target = !this.isSender ? this.connectedPeerId || undefined : undefined;
            if (data.type === 'offer') signalingService.sendOffer(this.roomId!, data, target);
            else if (data.type === 'answer') signalingService.sendAnswer(this.roomId!, data, target);
            else if (data.candidate) signalingService.sendCandidate(this.roomId!, data, target);
        });

        // 🚀 [신규] 재연결 이벤트 핸들링
        peer.on('reconnecting', () => {
            console.log('[WebRTC] Network handover detected. Reconnecting...');
            setStatus('CONNECTING'); // UI를 '연결 중' 상태로 변경
            // 사용자에게 토스트 알림 (선택)
            // toast.info('Network changed. Reconnecting...');
        });

        peer.on('connected', () => {
            logInfo('[WebRTC]', 'Channel Connected!');
            this.emit('connected', true);
            
            // 재연결 성공 시 상태 복구
            if (this.isTransferring) {
                setStatus('TRANSFERRING');
                // 재연결 후 전송이 멈춰있을 수 있으므로
                // 즉시 drain 이벤트를 트리거하여 전송 재개 시도
                if (this.isSender) {
                    this.requestMoreChunks();
                }
            } else {
                // 전송 중이 아니었다면 WAITING (Receiver) or READY (Sender)
                setStatus('WAITING');
            }
            
            // 🚀 [적응형 제어] Native Backpressure Event
            // 버퍼가 비워졌다는 이벤트를 받으면 즉시 다음 배치를 요청합니다.
            // polling(waitForBufferDrain)보다 훨씬 반응성이 좋고 CPU를 덜 씁니다.
            peer.on('drain', () => {
                if (this.isTransferring) {
                    this.requestMoreChunks();
                }
            });
        });

        peer.on('data', this.handleData.bind(this));
        
        peer.on('error', e => {
            console.error('[WebRTC] Peer Error:', e);
            this.emit('error', e.message);
        });
        
        peer.on('close', () => {
            this.emit('error', 'Connection closed');
        });

        this.peer = peer;
    } catch (err) {
        this.emit('error', 'Failed to create connection');
    }
  }

  private handleData(data: any) {
    // JSON 제어 메시지인지 확인 (문자열 또는 '{'로 시작하는 바이너리)
    if (typeof data === 'string' || (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 123)) {
        try {
            const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
            const msg = JSON.parse(str);
            
            // 기존 메시지 처리
            if (msg.type === 'TRANSFER_READY') {
                this.startWorkerTransfer(); // Sender: 전송 시작
            }
            else if (msg.type === 'MANIFEST') {
                this.handleMetadata(msg.manifest); // Receiver: 메타데이터 수신
            }
            else if (msg.type === 'DOWNLOAD_COMPLETE') {
                this.emit('complete', true); // Sender: 완료 확인
            }
            else if (msg.type === 'NACK') {
                // ... (NACK 처리 로직 유지)
            }
            
            // 🚀 [핵심 수정] 대기열 관련 메시지 라우팅
            else if (msg.type === 'QUEUED') {
                console.log('[WebRTC] ⏳ Queued message received:', msg);
                this.emit('queued', msg);
            }
            else if (msg.type === 'TRANSFER_STARTING') {
                console.log('[WebRTC] 🚀 Transfer starting message received (from queue)');
                this.emit('transfer-starting', msg);
                this.emit('remote-started', true); // 호환성 유지
            }
            else if (msg.type === 'TRANSFER_STARTED') {
                console.log('[WebRTC] 🚀 Transfer started message received');
                // 🚀 [핵심] TRANSFER_STARTED도 transfer-starting 이벤트로 처리
                this.emit('transfer-starting', msg);
                this.emit('remote-started', true); // 호환성 유지
            }
            else if (msg.type === 'READY_FOR_DOWNLOAD') {
                this.emit('ready-for-download', msg);
            }

        } catch (e) {
            console.error('[WebRTC] Failed to parse control message:', e);
        }
        return;
    }
    
    // Binary Data (File Chunk)
    if (this.writer) {
        const chunk = data instanceof Uint8Array ? data.buffer : data;
        this.writer.writeChunk(chunk).catch(console.error);
    }
  }

  private handlePeerJoined = async (data: any) => {
    if (this.peer && this.peer.connected) return;
    if (this.isSender) {
        this.connectedPeerId = data.socketId || data.from;
        await this.createPeer(true);
    }
  };

  private handleOffer = async (d: any) => {
    if (this.isSender) return;
    if (!this.connectedPeerId) this.connectedPeerId = d.from;
    if (d.from !== this.connectedPeerId) return;
    
    logInfo('[WebRTC]', `Received offer from ${d.from}`);
    
    if (!this.peer) await this.createPeer(false);
    this.peer!.signal(d.offer);
  };

  private handleAnswer = async (d: any) => {
    if (!this.isSender || !this.peer) return;
    
    logInfo('[WebRTC]', `Received answer from ${d.from}`);
    
    this.peer.signal(d.answer);
  };

  private handleIceCandidate = (d: any) => {
    if (!this.isSender && this.connectedPeerId && d.from !== this.connectedPeerId) return;
    this.peer?.signal(d.candidate);
  };

  public notifyDownloadComplete() {
    this.peer?.send(JSON.stringify({ type: 'DOWNLOAD_COMPLETE' }));
  }

  public getPeer() {
    return this.peer;
  }

  public sendControlMessage(message: string) {
    if (this.peer && this.peer.connected) {
      try {
        this.peer.send(message);
        console.log('[webRTCService] 📤 Control message sent:', message);
      } catch (e) {
        console.error('[webRTCService] ❌ Failed to send control message:', e);
      }
    } else {
      console.warn('[webRTCService] ⚠️ Cannot send control message - peer not available', {
        peerExists: !!this.peer,
        peerConnected: this.peer?.connected
      });
    }
  }

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

  public cleanup() {
    this.isTransferring = false;
    this.peer?.destroy();
    this.peer = null;
    this.worker?.terminate();
    this.worker = null;
    this.writer?.cleanup();
    this.connectedPeerId = null;
    this.networkController.reset();
  }
}

export const transferService = new EnhancedWebRTCService();
