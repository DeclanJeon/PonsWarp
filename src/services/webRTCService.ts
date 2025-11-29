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
import { NetworkAdaptiveController } from './networkAdaptiveController';
import { SinglePeerConnection } from './singlePeerConnection';

type EventHandler = (data: any) => void;

interface IFileWriter {
  initStorage(manifest: any): Promise<void>;
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
  
  // 🚀 [Step 12] 고정 배치 사이즈 (최대 성능)
  private readonly FIXED_BATCH_SIZE = BATCH_SIZE_MAX; // 128 (약 8MB)
  
  // Metrics Controller (단순 계측용)
  private networkController = new NetworkAdaptiveController();
  
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
    if (!this.peer || !this.peer.connected) return;
    
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
        
        // 3. UI 업데이트 (Metrics 사용)
        const metrics = this.networkController.getMetrics();
        this.emit('progress', {
            progress: metrics.progress,
            speed: metrics.speed,
            bytesTransferred: metrics.bytesSent,
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
    // 항상 최대 배치 크기로 요청 (Adaptive 제거)
    this.worker.postMessage({ type: 'process-batch', payload: { count: this.FIXED_BATCH_SIZE } });
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
      this.emit('progress', typeof progressData === 'object' ? progressData : { progress: progressData });
    });
    this.writer.onComplete((actualSize) => {
      this.emit('complete', { actualSize });
      this.notifyDownloadComplete();
    });
    this.writer.onError((err) => this.emit('error', err));
  }

  public async startReceiving(manifest: any) {
    if (!this.writer) return;
    try {
      await this.writer.initStorage(manifest);
      this.emit('storage-ready', true);
      this.emit('status', 'RECEIVING');
      this.peer?.send(JSON.stringify({ type: 'TRANSFER_READY' }));
    } catch (error: any) {
      this.emit('error', error.message);
    }
  }

  private async fetchTurnConfig(roomId: string) {
    try {
      const response: TurnConfigResponse = await signalingService.requestTurnConfig(roomId);
      if (response.success && response.data) this.iceServers = response.data.iceServers;
    } catch (error) {}
  }

  // ======================= PEER HANDLING =======================

  private async createPeer(initiator: boolean) {
    try {
        const peer = new SinglePeerConnection(
            this.connectedPeerId || 'unknown',
            initiator,
            { iceServers: this.iceServers }
        );

        peer.on('signal', data => {
            const target = !this.isSender ? this.connectedPeerId || undefined : undefined;
            if (data.type === 'offer') signalingService.sendOffer(this.roomId!, data, target);
            else if (data.type === 'answer') signalingService.sendAnswer(this.roomId!, data, target);
            else if (data.candidate) signalingService.sendCandidate(this.roomId!, data, target);
        });

        peer.on('connected', () => {
            logInfo('[WebRTC]', 'Channel Connected!');
            this.emit('connected', true);
            
            // 🚀 [Step 12] Native Backpressure Event
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
    if (typeof data === 'string' || (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 123)) {
        try {
            const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
            const msg = JSON.parse(str);
            
            if (msg.type === 'TRANSFER_READY') {
                this.peer?.send(JSON.stringify({ type: 'TRANSFER_STARTED' }));
                this.isTransferring = true;
                this.requestMoreChunks();
                this.emit('status', 'TRANSFERRING');
            } else if (msg.type === 'TRANSFER_STARTED') {
                this.emit('remote-started', true);
            } else if (msg.type === 'MANIFEST') {
                this.emit('metadata', msg.manifest);
            } else if (msg.type === 'DOWNLOAD_COMPLETE') {
                this.emit('complete', true);
            }
            // 그 외 메시지 (Queue 등)
            else if (msg.type === 'QUEUED' || msg.type === 'TRANSFER_STARTING' || msg.type === 'READY_FOR_DOWNLOAD') {
                const eventName = msg.type.toLowerCase().replace(/_/g, '-');
                this.emit(eventName, msg);
            }
        } catch (e) { }
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
    
    console.log('[WebRTC] 🔍 Received offer data:', {
      hasOffer: !!d.offer,
      offerType: typeof d.offer,
      offerKeys: d.offer ? Object.keys(d.offer) : [],
      offerContent: JSON.stringify(d.offer),
      hasType: !!d.offer?.type,
      hasSdp: !!d.offer?.sdp,
      sdpPreview: d.offer?.sdp?.substring(0, 50)
    });
    
    if (!this.peer) await this.createPeer(false);
    this.peer!.signal(d.offer);
  };

  private handleAnswer = async (d: any) => {
    if (!this.isSender || !this.peer) return;
    
    console.log('[WebRTC] 🔍 Received answer data:', {
      hasAnswer: !!d.answer,
      answerType: typeof d.answer,
      answerKeys: d.answer ? Object.keys(d.answer) : [],
      answerContent: d.answer
    });
    
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
