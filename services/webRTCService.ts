import SimplePeer from 'simple-peer/simplepeer.min.js';
import { signalingService, TurnConfigResponse } from './signaling';
import { getSenderWorkerV1 } from './workerFactory';
import { TransferManifest } from '../types';
import { logInfo, logError } from '../utils/logger';
import { 
  HEADER_SIZE, 
  MAX_BUFFERED_AMOUNT, 
  LOW_WATER_MARK, 
  HIGH_WATER_MARK,
  BATCH_SIZE_MIN,
  BATCH_SIZE_MAX,
  BATCH_SIZE_INITIAL,
  CHUNK_SIZE_MAX,
  MULTI_CHANNEL_COUNT
} from '../constants';
import { NetworkAdaptiveController } from './networkAdaptiveController';

type EventHandler = (data: any) => void;

// Writer 인터페이스
interface IFileWriter {
  initStorage(manifest: any): Promise<void>;
  writeChunk(packet: ArrayBuffer): Promise<void>;
  cleanup(): Promise<void>;
  onProgress(cb: (progress: number) => void): void;
  onComplete(cb: (actualSize: number) => void): void;
  onError(cb: (err: string) => void): void;
}

class EnhancedWebRTCService {
  private peer: SimplePeer.Instance | null = null;
  private worker: Worker | null = null;
  private writer: IFileWriter | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};
  private roomId: string | null = null;
  private isTransferring = false;
  private isSender = false;
  private isReceiverReady = false;
  
  // 🚀 [최적화] Backpressure 제어 변수
  private isProcessingBatch = false;
  private pendingManifest: TransferManifest | null = null;
  
  // 🚀 [Phase 1] 적응형 배치 크기 상태
  private currentBatchSize = BATCH_SIZE_INITIAL;
  private lastDrainTime = 0;
  private drainRate = 0; // bytes/ms
  private batchSendTime = 0;
  
  // 🚀 [Phase 3] 네트워크 적응형 컨트롤러
  private networkController = new NetworkAdaptiveController();
  private useAdaptiveControl = true;
  private lastMetricsUpdate = 0;
  private sendStartTimes: Map<number, number> = new Map(); // seq -> timestamp
  
  // 🚀 [Phase 3] 멀티 채널 (선택적 활성화)
  private useMultiChannel = false;
  private dataChannels: RTCDataChannel[] = [];
  private currentChannelIndex = 0;
  
  private iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  constructor() {
    signalingService.on('offer', this.handleOffer.bind(this));
    signalingService.on('answer', this.handleAnswer.bind(this));
    signalingService.on('ice-candidate', this.handleIceCandidate.bind(this));
    signalingService.on('peer-joined', this.handlePeerJoined.bind(this));
    
    // 🚨 [핵심 수정] Room Full 상태 처리 (에러가 아닌 정보성 메시지)
    signalingService.on('room-full', () => {
        this.emit('room-full', 'Room is currently occupied. Please wait for the current transfer to complete.');
        // cleanup() 호출하지 않음 - 사용자가 다시 시도할 수 있도록 유지
    });
  }

  public async connectSignaling() { await signalingService.connect(); }
  public generateRoomId() { this.roomId = Math.random().toString(36).substring(2, 8).toUpperCase(); return this.roomId; }
  public async joinRoom(roomId: string) { this.roomId = roomId; await signalingService.joinRoom(roomId); }

  // ======================= SENDER LOGIC (PULL-BASED) =======================

  public async initSender(manifest: TransferManifest, files: File[], roomId: string) {
    logInfo('[Sender]', 'Initializing Pull-Based Sender');
    this.cleanup();
    this.isSender = true;
    this.roomId = roomId;
    await this.connectSignaling();
    await this.joinRoom(roomId);
    await this.fetchTurnConfig(roomId);

    this.worker = getSenderWorkerV1();
    
    this.worker.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === 'ready') this.worker!.postMessage({ type: 'init', payload: { files, manifest } });
      else if (type === 'chunk-batch') this.handleBatchFromWorker(payload);
      else if (type === 'complete') this.finishTransfer();
    };

    this.emit('status', 'WAITING_FOR_PEER');
    this.pendingManifest = manifest;
  }

  /**
   * 🚀 [Phase 1 + Phase 3] 적응형 배치 크기 + 파이프라인 최적화 + 네트워크 적응형 제어
   */
  private handleBatchFromWorker(payload: any) {
    if (!this.peer || this.peer.destroyed) return;
    
    // @ts-ignore
    const channel = this.peer._channel as RTCDataChannel;
    if (channel.readyState !== 'open') return;

    const { chunks, progressData } = payload;
    const batchBytes = chunks.reduce((sum: number, c: ArrayBuffer) => sum + c.byteLength, 0);
    
    this.isProcessingBatch = false;

    try {
        // 1. 청크 전송
        const sendStart = performance.now();
        
        // 🚀 [Phase 3] 멀티 채널 사용 시 분산 전송
        if (this.useMultiChannel && this.dataChannels.length > 0) {
            this.sendChunksMultiChannel(chunks);
        } else {
            for (const chunk of chunks) {
                // 🚀 [Phase 3] 전송 시간 기록 (RTT 측정용)
                const view = new DataView(chunk);
                const seq = view.getUint32(2, true);
                this.sendStartTimes.set(seq, performance.now());
                
                this.peer.send(chunk);
                
                // 🚀 [Phase 3] 네트워크 컨트롤러에 전송 기록
                if (this.useAdaptiveControl) {
                    this.networkController.recordSend(chunk.byteLength);
                }
            }
        }
        
        // 2. 진행률 방출 (속도 정보 포함)
        this.emit('progress', {
            ...progressData,
            networkMetrics: this.useAdaptiveControl ? this.networkController.getMetrics() : null
        });

        // 3. 🚀 [Phase 1 + Phase 3] 드레인 속도 측정 및 배치 크기 조절
        this.updateDrainMetrics(channel, batchBytes, sendStart);
        
        // 🚀 [Phase 3] 네트워크 컨트롤러 버퍼 상태 업데이트
        if (this.useAdaptiveControl) {
            this.networkController.updateBufferState(channel.bufferedAmount);
        }

        // 4. 🚀 [핵심] 버퍼 상태에 따른 즉시 요청
        //    HIGH_WATER_MARK 이하면 즉시 다음 배치 요청 (파이프라인 유지)
        const canSend = this.useAdaptiveControl 
            ? this.networkController.canSend(channel.bufferedAmount)
            : channel.bufferedAmount < HIGH_WATER_MARK;
            
        if (canSend) {
            this.requestMoreChunks();
        }

    } catch (e) {
        console.error('Send failed:', e);
        this.cleanup();
    }
  }
  
  /**
   * 🚀 [Phase 3] 멀티 채널 분산 전송
   */
  private sendChunksMultiChannel(chunks: ArrayBuffer[]): void {
    for (const chunk of chunks) {
        // 버퍼 여유가 가장 많은 채널 선택
        const channel = this.getBestChannel();
        if (channel && channel.readyState === 'open') {
            const view = new DataView(chunk);
            const seq = view.getUint32(2, true);
            this.sendStartTimes.set(seq, performance.now());
            
            channel.send(chunk);
            
            if (this.useAdaptiveControl) {
                this.networkController.recordSend(chunk.byteLength);
            }
        }
    }
  }
  
  /**
   * 🚀 [Phase 3] 최적 채널 선택 (버퍼 여유 기반)
   */
  private getBestChannel(): RTCDataChannel | null {
    if (this.dataChannels.length === 0) {
        // @ts-ignore
        return this.peer?._channel as RTCDataChannel;
    }
    
    let bestChannel: RTCDataChannel | null = null;
    let lowestBuffer = Infinity;
    
    for (const channel of this.dataChannels) {
        if (channel.readyState === 'open' && channel.bufferedAmount < lowestBuffer) {
            lowestBuffer = channel.bufferedAmount;
            bestChannel = channel;
        }
    }
    
    return bestChannel;
  }

  /**
   * 🚀 [Phase 1] 드레인 속도 측정 및 적응형 배치 크기 계산
   */
  private updateDrainMetrics(channel: RTCDataChannel, batchBytes: number, sendStart: number) {
    const now = performance.now();
    
    if (this.lastDrainTime > 0 && this.batchSendTime > 0) {
      const elapsed = now - this.lastDrainTime;
      if (elapsed > 0) {
        // 이동 평균으로 드레인 속도 계산
        const instantDrainRate = batchBytes / elapsed;
        this.drainRate = this.drainRate === 0 
          ? instantDrainRate 
          : this.drainRate * 0.7 + instantDrainRate * 0.3;
        
        // 적응형 배치 크기 계산
        this.adjustBatchSize(channel);
      }
    }
    
    this.lastDrainTime = now;
    this.batchSendTime = now - sendStart;
  }

  /**
   * 🚀 [Phase 1 + Phase 3] 적응형 배치 크기 조절 (AIMD + BBR 통합)
   */
  private adjustBatchSize(channel: RTCDataChannel) {
    const bufferUtilization = channel.bufferedAmount / MAX_BUFFERED_AMOUNT;
    const oldBatchSize = this.currentBatchSize;
    
    // 🚀 [Phase 3] 네트워크 적응형 컨트롤러 사용 시
    if (this.useAdaptiveControl) {
      const adaptiveParams = this.networkController.getAdaptiveParams();
      this.currentBatchSize = adaptiveParams.batchSize;
      
      if (oldBatchSize !== this.currentBatchSize) {
        const metrics = this.networkController.getMetrics();
        logInfo('[Adaptive-BBR]', `Batch: ${oldBatchSize} → ${this.currentBatchSize} (RTT: ${metrics.avgRtt.toFixed(1)}ms, throughput: ${(metrics.throughput / 1024 / 1024).toFixed(2)}MB/s)`);
      }
      return;
    }
    
    // 기존 AIMD 로직 (fallback)
    if (bufferUtilization < 0.3) {
      this.currentBatchSize = Math.min(
        BATCH_SIZE_MAX, 
        this.currentBatchSize + 4
      );
    } else if (bufferUtilization > 0.7) {
      this.currentBatchSize = Math.max(
        BATCH_SIZE_MIN, 
        Math.floor(this.currentBatchSize * 0.75)
      );
    }
    
    if (this.drainRate > 0) {
      const optimalBatch = Math.floor(
        (MAX_BUFFERED_AMOUNT - channel.bufferedAmount) / CHUNK_SIZE_MAX
      );
      
      this.currentBatchSize = Math.max(
        BATCH_SIZE_MIN,
        Math.min(BATCH_SIZE_MAX, Math.floor((this.currentBatchSize + optimalBatch) / 2))
      );
    }
    
    if (oldBatchSize !== this.currentBatchSize) {
      logInfo('[Adaptive]', `Batch size: ${oldBatchSize} → ${this.currentBatchSize} (buffer: ${(bufferUtilization * 100).toFixed(1)}%)`);
    }
  }

  private requestMoreChunks() {
    if (this.isProcessingBatch || !this.worker || !this.isTransferring) return;
    
    this.isProcessingBatch = true;
    // 🚀 [Phase 1] 적응형 배치 크기 사용
    this.worker.postMessage({ type: 'process-batch', payload: { count: this.currentBatchSize } });
  }


  private waitForBufferDrain(channel: RTCDataChannel): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (channel.bufferedAmount <= 256 * 1024 || channel.readyState !== 'open') resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  private startTransferSequence() {
    if (!this.peer || !this.pendingManifest) return;
    // Manifest 전송 (Sender -> Receiver)
    this.peer.send(JSON.stringify({ type: 'MANIFEST', manifest: this.pendingManifest }));
    this.isReceiverReady = false;
    this.emit('status', 'WAITING_FOR_ACCEPTANCE');
  }

  private async finishTransfer() {
    this.isTransferring = false;
    
    // 남은 버퍼가 다 전송될 때까지 대기
    await this.waitForBufferZero();
    
    // 🚀 [버그 수정] 추가 대기 시간 - 네트워크 지연 고려
    // WebRTC 버퍼가 비워져도 실제 전송이 완료되지 않았을 수 있음
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // EOS 패킷 전송
    const eosPacket = new ArrayBuffer(HEADER_SIZE);
    const view = new DataView(eosPacket);
    view.setUint16(0, 0xFFFF, true); // FileIndex 0xFFFF = 종료 신호
    
    try {
      this.peer?.send(eosPacket);
      logInfo('[Sender]', 'EOS sent');
      this.emit('remote-processing', true);
    } catch (e) {
      console.error('Failed to send EOS', e);
    }
  }

  private waitForBufferZero(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        // @ts-ignore
        const channel = this.peer?._channel as RTCDataChannel;
        if (!channel || channel.bufferedAmount === 0) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  // ======================= RECEIVER LOGIC =======================

  // 2. initReceiver 메서드 수정 (연결 안정성 강화)
  public async initReceiver(roomId: string) {
    console.log('[Receiver] Initializing...');
    this.cleanup(); // 기존 상태 완전 초기화
    
    this.isSender = false;
    this.roomId = roomId;

    // 시그널링 연결
    await this.connectSignaling();
    await this.joinRoom(roomId);
    
    // TURN 설정 가져오기 (비동기로 하되 연결을 막지 않음)
    this.fetchTurnConfig(roomId).catch(err => console.warn('TURN config failed', err));

    this.emit('status', 'CONNECTING');
    
    // 🚨 [추가] Receiver는 Sender가 들어오기를 기다리거나,
    // 이미 Sender가 있다면 Sender가 'peer-joined'를 받고 Offer를 보내기를 기다림.
    // 만약 Sender가 반응이 없으면(이미 연결된 줄 알고), 수동으로 존재를 알릴 필요가 있을 수 있음.
  }

  public setWriter(writerInstance: IFileWriter) {
    if (this.writer) this.writer.cleanup();
    this.writer = writerInstance;

    // 🚀 [Phase 1] progress 데이터를 객체 형태로 전달 (속도 정보 포함)
    this.writer.onProgress((progressData: any) => {
      // progressData가 객체인 경우 그대로 전달, 숫자인 경우 객체로 변환
      if (typeof progressData === 'object') {
        this.emit('progress', progressData);
      } else {
        this.emit('progress', { progress: progressData, speed: 0, bytesTransferred: 0, totalBytes: 0 });
      }
    });
    this.writer.onComplete((actualSize) => {
      this.emit('complete', { actualSize });
      this.notifyDownloadComplete();
    });
    this.writer.onError((err) => this.emit('error', err));
  }

  public async startReceiving(manifest: any) {
    if (!this.writer) {
      this.emit('error', 'Storage writer not initialized');
      return;
    }

    try {
      console.log('[Receiver] Initializing storage writer...');
      await this.writer.initStorage(manifest);
      
      console.log('[Receiver] Storage ready. Sending TRANSFER_READY...');
      this.emit('storage-ready', true);
      this.emit('status', 'RECEIVING');

      if (this.peer && !this.peer.destroyed) {
        this.peer.send(JSON.stringify({ type: 'TRANSFER_READY' }));
      }
    } catch (error: any) {
      console.error('[Receiver] Storage init failed:', error);
      this.emit('error', error.message || 'Failed to initialize storage');
    }
  }

  private async fetchTurnConfig(roomId: string) {
    try {
      const response: TurnConfigResponse = await signalingService.requestTurnConfig(roomId);
      if (response.success && response.data) {
        this.iceServers = response.data.iceServers;
      }
    } catch (error) {
      // Use default STUN
    }
  }

  // ======================= PEER HANDLING =======================

  private async createPeer(initiator: boolean) {
    try {
        const peer = new SimplePeer({
            initiator,
            trickle: true,
            config: { iceServers: this.iceServers },
            channelConfig: {
                ordered: true,
                // 🚀 [핵심] Low Water Mark 설정 (배압 제어용)
                bufferedAmountLowThreshold: LOW_WATER_MARK
            },
        } as any);

        const forceArrayBuffer = () => {
            // @ts-ignore
            if (peer._channel && peer._channel.binaryType !== 'arraybuffer') {
                // @ts-ignore
                peer._channel.binaryType = 'arraybuffer';
            }
        };

        if (initiator) forceArrayBuffer();

        peer.on('signal', data => {
            if (data.type === 'offer') signalingService.sendOffer(this.roomId!, data);
            else if (data.type === 'answer') signalingService.sendAnswer(this.roomId!, data);
            else if (data.candidate) signalingService.sendCandidate(this.roomId!, data);
        });

        peer.on('connect', () => {
            forceArrayBuffer();
            console.log('[WebRTC] Channel Connected!');
            this.emit('connected', true);
            
            // 🚀 [핵심] DataChannel 배압 이벤트 리스너 등록
            // @ts-ignore
            const channel = peer._channel as RTCDataChannel;
            if (channel) {
                channel.onbufferedamountlow = () => {
                    // 버퍼가 비워지면 워커에게 더 요청
                    if (this.isTransferring) {
                        this.requestMoreChunks();
                    }
                };
            }

            if (initiator) this.startTransferSequence();
        });

        peer.on('data', this.handleData.bind(this));
        peer.on('error', e => {
            console.error('[WebRTC] Peer Error:', e);
            // 치명적이지 않은 에러는 무시
            if (e.code === 'ERR_DATA_CHANNEL') return;
            this.emit('error', e.message);
        });
        
        peer.on('close', () => {
            console.log('[WebRTC] Connection Closed');
            this.emit('error', 'Connection closed');
        });

        this.peer = peer;
    } catch (err) {
        console.error('Failed to create peer:', err);
        this.emit('error', 'Failed to create connection');
    }
  }

  private handleData(data: any) {
    // 1. 문자열 (JSON Control Message)
    if (typeof data === 'string' || (data instanceof Uint8Array && data[0] === 123)) { // '{' check
        try {
            const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
            const msg = JSON.parse(str);
            
            if (msg.type === 'TRANSFER_READY') {
                console.log('[Sender] Receiver READY. Sending ACK and Starting transfer...');
                
                // 🚨 [추가] 수신자에게 "시작됨" 알림 (UX 피드백용)
                if (this.peer && !this.peer.destroyed) {
                    this.peer.send(JSON.stringify({ type: 'TRANSFER_STARTED' }));
                }

                this.isTransferring = true;
                this.requestMoreChunks(); // 첫 배치 요청
                this.emit('status', 'TRANSFERRING');
            
            } else if (msg.type === 'TRANSFER_STARTED') {
                // 🚨 [추가] 수신자: 송신자가 시작했다는 응답 수신
                console.log('[Receiver] Sender acknowledged start request.');
                this.emit('remote-started', true);

            } else if (msg.type === 'MANIFEST') {
                this.emit('metadata', msg.manifest);
            } else if (msg.type === 'DOWNLOAD_COMPLETE') {
                this.emit('complete', true);
            }
        } catch (e) {
            // JSON 파싱 실패 시 바이너리로 간주할 수도 있음
        }
        return;
    }
    
    // 2. 바이너리 (File Chunk)
    if (this.writer) {
        // Uint8Array -> ArrayBuffer 변환 (필요시)
        const chunk = data instanceof Uint8Array
            ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            : data;
        this.writer.writeChunk(chunk);
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

  // 🚨 [핵심 수정] Peer 중복 생성 방지 및 연결 안정화
  private handlePeerJoined = async () => {
    // 이미 연결된 상태라면 무시 (좀비 세션 방지)
    if (this.peer && !this.peer.destroyed) {
        // @ts-ignore
        if (this.peer._connected || this.peer.connected) {
            console.warn('[WebRTC] Peer joined but we are already connected. Ignoring.');
            return;
        }
    }

    console.log('[WebRTC] New peer joined. Initiating connection...');
    if (this.peer) {
        this.peer.destroy();
        this.peer = null;
    }

    // Sender만 Initiator가 됨
    if (this.isSender) {
        await this.createPeer(true);
    }
  };

  private handleOffer = async (d: any) => {
    if (!this.peer) await this.createPeer(false);
    this.peer!.signal(d.offer);
  };

  private handleAnswer = async (d: any) => {
    this.peer?.signal(d.answer);
  };

  private handleIceCandidate = (d: any) => {
    this.peer?.signal(d.candidate);
  };

  public notifyDownloadComplete() {
    if (this.peer && !this.peer.destroyed) {
      const msg = JSON.stringify({ type: 'DOWNLOAD_COMPLETE' });
      this.peer.send(msg);
    }
  }

  /**
   * 🚀 [Phase 3] 적응형 제어 활성화/비활성화
   */
  public setAdaptiveControl(enabled: boolean): void {
    this.useAdaptiveControl = enabled;
    if (enabled) {
      this.networkController.reset();
      this.networkController.start();
    }
    logInfo('[WebRTC]', `Adaptive control: ${enabled ? 'enabled' : 'disabled'}`);
  }
  
  /**
   * 🚀 [Phase 3] 멀티 채널 활성화/비활성화
   */
  public setMultiChannel(enabled: boolean): void {
    this.useMultiChannel = enabled;
    logInfo('[WebRTC]', `Multi-channel: ${enabled ? 'enabled' : 'disabled'}`);
  }
  
  /**
   * 🚀 [Phase 3] 네트워크 메트릭 조회
   */
  public getNetworkMetrics() {
    return this.networkController.getMetrics();
  }
  
  /**
   * 🚀 [Phase 3] 혼잡 제어 상태 조회
   */
  public getCongestionState() {
    return this.networkController.getCongestionState();
  }
  
  /**
   * 🚀 [Phase 3] 디버그 정보 조회
   */
  public getDebugInfo() {
    return {
      adaptiveControl: this.useAdaptiveControl,
      multiChannel: this.useMultiChannel,
      channelCount: this.dataChannels.length,
      currentBatchSize: this.currentBatchSize,
      drainRate: this.drainRate,
      networkController: this.networkController.getDebugInfo()
    };
  }

  public cleanup() {
    this.isTransferring = false;
    this.peer?.destroy();
    this.peer = null;
    this.worker?.terminate();
    this.worker = null;
    this.writer?.cleanup();
    
    // 🚀 [Phase 3] 추가 정리
    this.networkController.reset();
    this.dataChannels.forEach(ch => ch.close());
    this.dataChannels = [];
    this.sendStartTimes.clear();
  }
}

export const transferService = new EnhancedWebRTCService();
