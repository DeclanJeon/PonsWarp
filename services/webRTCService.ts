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
  
  // 🚀 [Phase 1 + Phase 3] 적응형 배치 크기 상태
  private currentBatchSize = BATCH_SIZE_INITIAL; // 32로 증가됨
  private lastDrainTime = 0;
  private drainRate = 0; // bytes/ms
  private batchSendTime = 0;
  
  // 🚀 [Phase 3] 네트워크 적응형 컨트롤러
  private networkController = new NetworkAdaptiveController();
  private useAdaptiveControl = true;
  private lastMetricsUpdate = 0;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  
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
      if (type === 'ready') {
        console.log('[Sender] Worker ready, initializing with files...');
        this.worker!.postMessage({ type: 'init', payload: { files, manifest } });
      }
      else if (type === 'init-complete') {
        console.log('[Sender] ✅ Worker initialization complete');
        this.emit('worker-ready', true);
      }
      else if (type === 'error') {
        console.error('[Sender] ❌ Worker error:', payload);
        this.emit('error', payload.message || 'Worker initialization failed');
      }
      else if (type === 'chunk-batch') this.handleBatchFromWorker(payload);
      else if (type === 'complete') this.finishTransfer();
    };

    this.emit('status', 'WAITING_FOR_PEER');
    this.pendingManifest = manifest;
  }

  /**
   * 🚀 [긴급 수정] Burst Transfer Mode
   * 루프 내부의 await를 제거하여 JS 실행 지연을 0으로 만듭니다.
   */
  private async handleBatchFromWorker(payload: any) {
    if (!this.peer || this.peer.destroyed) return;
    
    // @ts-ignore
    const channel = this.peer._channel as RTCDataChannel;
    if (!channel || channel.readyState !== 'open') return;

    const { chunks, progressData } = payload;
    const batchBytes = chunks.reduce((sum: number, c: ArrayBuffer) => sum + c.byteLength, 0);
    
    this.isProcessingBatch = false;

    try {
        // 🚨 [수정 1] 루프 진입 전 '한 번만' 버퍼 체크 (Pre-check)
        // 버퍼가 꽉 찼을 때만 여기서 대기하고, 루프 진입 후에는 멈추지 않음
        if (channel.bufferedAmount + batchBytes > MAX_BUFFERED_AMOUNT) {
            await this.waitForBufferDrain(channel);
        }

        const sendStart = performance.now();
        
        // 🚨 [수정 2] Burst Sending (루프 내 await 절대 금지)
        if (this.useMultiChannel && this.dataChannels.length > 0) {
            this.sendChunksMultiChannel(chunks);
        } else {
            // JS 루프는 1ms 이내에 완료됨 -> WebRTC 버퍼로 순식간에 이동
            for (let i = 0; i < chunks.length; i++) {
                try {
                    this.peer.send(chunks[i]); // 동기 호출 (즉시 리턴)
                    
                    if (this.useAdaptiveControl) {
                        this.networkController.recordSend(chunks[i].byteLength);
                    }
                } catch (e) {
                    // 전송 실패 시 연결 유지를 위해 해당 청크만 포기하고 계속 진행
                    console.warn('Chunk send glitch:', e);
                    continue;
                }
            }
        }
        
        // 2. 진행률 업데이트
        this.emit('progress', {
            ...progressData,
            networkMetrics: this.useAdaptiveControl ? this.networkController.getMetrics() : null
        });

        this.updateDrainMetrics(channel, batchBytes, sendStart);
        
        if (this.useAdaptiveControl) {
            this.networkController.updateBufferState(channel.bufferedAmount);
        }

        // 3. Greedy Refill (공격적 리필)
        // 루프가 순식간에 끝났으므로 즉시 워커에 다음 데이터를 요청
        const currentBuffered = channel.bufferedAmount;
        if (currentBuffered < HIGH_WATER_MARK) {
            this.requestMoreChunks();
        }

    } catch (e) {
        console.error('[Sender] Batch error:', e);
        this.cleanup();
    }
  }
  /**
   * 🚀 [최적화] 버퍼 대기 시간 및 체크 주기 단축
   */
  private async waitForBufferDrain(channel: RTCDataChannel): Promise<void> {
    const maxWaitTime = 5000;
    const checkInterval = 5;  // 10ms -> 5ms (반응성 향상)
    let elapsedTime = 0;
    const targetLevel = MAX_BUFFERED_AMOUNT * 0.7; // 70% 수준까지 대기

    while (channel.bufferedAmount > targetLevel && elapsedTime < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      elapsedTime += checkInterval;
      if (channel.readyState !== 'open') return;
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
    
    // 🚨 [수정] ZIP 압축률 계산 (원본 대비 전송 데이터 비율)
    let compressionRatio = 1.0; // 기본값 (압축 없음)
    if (this.worker && this.pendingManifest && this.pendingManifest.totalFiles > 1) {
      // ZIP 모드인 경우 압축률 추정
      compressionRatio = this.estimateZipCompressionRatio();
      console.log('[Adaptive] 📊 [DEBUG] ZIP compression ratio:', compressionRatio.toFixed(2));
    }
    
    // 🚀 [Phase 3] 네트워크 적응형 컨트롤러 사용 시
    if (this.useAdaptiveControl) {
      const adaptiveParams = this.networkController.getAdaptiveParams();
      
      // 🚨 [수정] ZIP 압축률을 고려한 배치 크기 조절
      const adjustedBatchSize = Math.floor(adaptiveParams.batchSize / compressionRatio);
      this.currentBatchSize = Math.max(BATCH_SIZE_MIN, Math.min(BATCH_SIZE_MAX, adjustedBatchSize));
      
      if (oldBatchSize !== this.currentBatchSize) {
        const metrics = this.networkController.getMetrics();
        logInfo('[Adaptive-BBR]', `Batch: ${oldBatchSize} → ${this.currentBatchSize} (compression: ${compressionRatio.toFixed(2)}, RTT: ${metrics.avgRtt.toFixed(1)}ms, throughput: ${(metrics.throughput / 1024 / 1024).toFixed(2)}MB/s)`);
      }
      return;
    }
    
    // 기존 AIMD 로직 (fallback) - ZIP 압축률 고려
    let targetBatchSize = this.currentBatchSize;
    
    if (bufferUtilization < 0.3) {
      // 버퍼 여유가 많으면 증가 (ZIP 압축률 반영)
      targetBatchSize = Math.floor(this.currentBatchSize * 1.2 / compressionRatio);
    } else if (bufferUtilization > 0.7) {
      // 버퍼가 거의 차면 감소
      targetBatchSize = Math.floor(this.currentBatchSize * 0.75);
    }
    
    if (this.drainRate > 0) {
      const optimalBatch = Math.floor(
        (MAX_BUFFERED_AMOUNT - channel.bufferedAmount) / (CHUNK_SIZE_MAX * compressionRatio)
      );
      
      targetBatchSize = Math.floor((targetBatchSize + optimalBatch) / 2);
    }
    
    this.currentBatchSize = Math.max(
      BATCH_SIZE_MIN,
      Math.min(BATCH_SIZE_MAX, targetBatchSize)
    );
    
    if (oldBatchSize !== this.currentBatchSize) {
      logInfo('[Adaptive]', `Batch size: ${oldBatchSize} → ${this.currentBatchSize} (compression: ${compressionRatio.toFixed(2)}, buffer: ${(bufferUtilization * 100).toFixed(1)}%)`);
    }
  }
  
  /**
   * 🚨 [추가] ZIP 압축률 추정 함수
   */
  private estimateZipCompressionRatio(): number {
    // 파일 종류에 따른 평균 압축률
    const fileTypes = this.pendingManifest?.files?.map(f => f.name.split('.').pop()?.toLowerCase()) || [];
    
    let totalCompressionRatio = 0;
    let fileCount = 0;
    
    for (const fileType of fileTypes) {
      let compressionRatio = 1.0; // 기본값 (압축 없음)
      
      // 파일 종류별 압축률 (실제 경험 기반)
      switch (fileType) {
        case 'txt':
        case 'csv':
        case 'json':
        case 'xml':
        case 'md':
          compressionRatio = 0.3; // 텍스트 파일은 압축률이 높음
          break;
        case 'js':
        case 'css':
        case 'html':
        case 'ts':
          compressionRatio = 0.4; // 코드 파일
          break;
        case 'jpg':
        case 'jpeg':
        case 'png':
        case 'gif':
        case 'mp3':
        case 'mp4':
        case 'avi':
          compressionRatio = 1.1; // 이미지/영상은 오히려 더 커질 수 있음
          break;
        case 'pdf':
        case 'doc':
        case 'docx':
        case 'xls':
        case 'xlsx':
          compressionRatio = 0.8; // 문서 파일
          break;
        case 'zip':
        case 'rar':
        case '7z':
          compressionRatio = 1.2; // 이미 압축된 파일
          break;
        default:
          compressionRatio = 0.7; // 기타 파일
      }
      
      totalCompressionRatio += compressionRatio;
      fileCount++;
    }
    
    const averageCompressionRatio = fileCount > 0 ? totalCompressionRatio / fileCount : 1.0;
    
    console.log('[Adaptive] 📊 [DEBUG] Compression analysis:', {
      fileTypes,
      averageCompressionRatio: averageCompressionRatio.toFixed(2),
      fileCount
    });
    
    return averageCompressionRatio;
  }

  private requestMoreChunks() {
    if (this.isProcessingBatch || !this.worker || !this.isTransferring) return;
    
    this.isProcessingBatch = true;
    // 🚀 [Phase 1] 적응형 배치 크기 사용
    this.worker.postMessage({ type: 'process-batch', payload: { count: this.currentBatchSize } });
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
    // 🚨 [핵심 수정] 이미 같은 방에 연결 중이거나 연결된 상태면 중복 초기화 방지
    if (this.roomId === roomId && !this.isSender) {
      console.log('[Receiver] Already initializing for room:', roomId);
      return;
    }
    
    // 🚨 [핵심 수정] 이미 peer가 연결된 상태면 cleanup 건너뛰기
    // @ts-ignore
    const isConnected = this.peer && !this.peer.destroyed && (this.peer._connected || this.peer.connected);
    if (isConnected && this.roomId === roomId) {
      console.log('[Receiver] Already connected to room:', roomId);
      return;
    }
    
    console.log('[Receiver] Initializing...');
    
    // 🚨 [핵심 수정] 다른 방에 연결 중이었다면 cleanup, 같은 방이면 건너뛰기
    if (this.roomId && this.roomId !== roomId) {
      this.cleanup();
    }
    
    this.isSender = false;
    this.roomId = roomId;

    // 시그널링 연결
    await this.connectSignaling();
    await this.joinRoom(roomId);
    
    // TURN 설정 가져오기 (비동기로 하되 연결을 막지 않음)
    this.fetchTurnConfig(roomId).catch(err => console.warn('TURN config failed', err));

    this.emit('status', 'CONNECTING');
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
      
      // 🚨 [핵심 수정] writer.initStorage()가 완전히 완료될 때까지 대기
      // ZIP 초기화, 파일 다이얼로그 등이 모두 끝나야 함
      await this.writer.initStorage(manifest);
      
      console.log('[Receiver] ✅ Storage fully initialized. Sending TRANSFER_READY...');
      this.emit('storage-ready', true);
      this.emit('status', 'RECEIVING');

      // 🚨 [핵심] 이제 송신자에게 준비 완료 신호 전송
      if (this.peer && !this.peer.destroyed) {
        this.peer.send(JSON.stringify({ type: 'TRANSFER_READY' }));
        console.log('[Receiver] TRANSFER_READY sent to sender');
      } else {
        console.error('[Receiver] Cannot send TRANSFER_READY - peer not connected');
        this.emit('error', 'Connection lost during initialization');
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
            // 🚀 [Multi-Receiver] Receiver는 connectedPeerId(Sender)에게만 시그널 전송
            const target = !this.isSender ? this.connectedPeerId || undefined : undefined;
            
            if (data.type === 'offer') signalingService.sendOffer(this.roomId!, data, target);
            else if (data.type === 'answer') signalingService.sendAnswer(this.roomId!, data, target);
            else if (data.candidate) signalingService.sendCandidate(this.roomId!, data, target);
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

            // 🚀 [Phase 3] WebRTC 통계 수집 시작
            if (this.useAdaptiveControl && initiator) {
                this.startStatsCollection();
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
    // 1. 제어 메시지 처리
    if (typeof data === 'string' || (data instanceof Uint8Array && data[0] === 123)) {
        try {
            const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
            const msg = JSON.parse(str);
            
            if (msg.type === 'TRANSFER_READY') {
                console.log('[Sender] Receiver READY. Sending ACK and Starting transfer...');
                
                if (this.peer && !this.peer.destroyed) {
                    this.peer.send(JSON.stringify({ type: 'TRANSFER_STARTED' }));
                }

                this.isTransferring = true;
                this.requestMoreChunks();
                this.emit('status', 'TRANSFERRING');
            
            } else if (msg.type === 'TRANSFER_STARTED') {
                console.log('[Receiver] Sender acknowledged start request.');
                this.emit('remote-started', true);

            } else if (msg.type === 'TRANSFER_STARTED_WITHOUT_YOU' || msg.type === 'TRANSFER_ALREADY_STARTED') {
                console.warn('[Receiver] Transfer started without us:', msg.message);
                this.emit('transfer-missed', msg.message);

            } else if (msg.type === 'QUEUED') {
                console.log('[Receiver] Added to queue:', msg);
                this.emit('queued', { message: msg.message, position: msg.position });

            } else if (msg.type === 'TRANSFER_STARTING') {
                console.log('[Receiver] Transfer starting from queue');
                this.emit('transfer-starting', true);
                this.emit('status', 'RECEIVING');

            } else if (msg.type === 'READY_FOR_DOWNLOAD') {
                console.log('[Receiver] Ready for download:', msg);
                this.emit('ready-for-download', { message: msg.message });

            } else if (msg.type === 'MANIFEST') {
                this.emit('metadata', msg.manifest);
            } else if (msg.type === 'DOWNLOAD_COMPLETE') {
                this.emit('complete', true);
            }
        } catch (e) {
            // JSON 파싱 실패 무시
        }
        return;
    }
    
    // 🚨 [수정 3] 수신 측 로직 변경: 디스크 쓰기 대기 제거 (Fire-and-Forget)
    if (this.writer) {
        const chunk = data instanceof Uint8Array
            ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            : data;
        
        // 🚨 [핵심] await 제거: 네트워크 수신 루프를 차단하지 않음
        // 디스크 쓰기가 느려도 네트워크 ACK는 즉시 보냄 (메모리 버퍼링 활용)
        this.writer.writeChunk(chunk).catch(err => {
            console.error('[WebRTC] Async write error:', err);
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

  // 🚨 [핵심 수정] 연결된 피어 ID 추적
  private connectedPeerId: string | null = null;

  private handleOffer = async (d: any) => {
    // 🚨 [핵심] Receiver만 offer를 처리 (Sender는 무시)
    if (this.isSender) return;
    
    // 첫 번째 offer를 보낸 피어를 기억
    if (!this.connectedPeerId) {
      this.connectedPeerId = d.from;
    }
    
    // 다른 피어의 offer는 무시
    if (d.from !== this.connectedPeerId) {
      console.log('[WebRTC] Ignoring offer from different peer:', d.from);
      return;
    }
    
    if (!this.peer) await this.createPeer(false);
    this.peer!.signal(d.offer);
  };

  private handleAnswer = async (d: any) => {
    // 🚨 [핵심] Sender만 answer를 처리 (Receiver는 무시)
    if (!this.isSender) return;
    
    // 피어가 없거나 파괴된 경우 무시
    if (!this.peer || this.peer.destroyed) return;
    
    this.peer.signal(d.answer);
  };

  private handleIceCandidate = (d: any) => {
    // 🚨 [핵심] 연결된 피어의 ICE candidate만 처리
    if (!this.isSender && this.connectedPeerId && d.from !== this.connectedPeerId) {
      console.log('[WebRTC] Ignoring ICE candidate from different peer:', d.from);
      return;
    }
    
    // 피어가 없거나 파괴된 경우 무시
    if (!this.peer || this.peer.destroyed) return;
    
    this.peer.signal(d.candidate);
  };

  public notifyDownloadComplete() {
    if (this.peer && !this.peer.destroyed) {
      const msg = JSON.stringify({ type: 'DOWNLOAD_COMPLETE' });
      console.log('[webRTCService] 📤 Sending DOWNLOAD_COMPLETE to sender');
      
      // 🚀 [개선] 재전송 메커니즘: 3번 전송하여 신뢰성 향상
      let successCount = 0;
      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          try {
            if (this.peer && !this.peer.destroyed) {
              this.peer.send(msg);
              successCount++;
              console.log(`[webRTCService] ✅ DOWNLOAD_COMPLETE sent (${i + 1}/3)`);
            }
          } catch (e) {
            console.error(`[webRTCService] ❌ Failed to send DOWNLOAD_COMPLETE (${i + 1}/3):`, e);
          }
        }, i * 100); // 100ms 간격
      }
    } else {
      console.warn('[webRTCService] ⚠️ Cannot send DOWNLOAD_COMPLETE - peer not available', {
        peerExists: !!this.peer,
        peerDestroyed: this.peer?.destroyed
      });
    }
  }

  /**
   * 🚀 [Phase 3] WebRTC 통계 수집 시작
   */
  private startStatsCollection(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    
    this.networkController.reset();
    this.networkController.start();
    
    // 500ms마다 WebRTC 통계 수집
    this.statsInterval = setInterval(async () => {
      if (!this.peer || this.peer.destroyed || !this.isTransferring) {
        this.stopStatsCollection();
        return;
      }
      
      try {
        // @ts-ignore - SimplePeer 내부 접근
        const pc = this.peer._pc as RTCPeerConnection;
        if (pc) {
          const stats = await pc.getStats();
          this.networkController.updateFromWebRTCStats(stats);
        }
      } catch (e) {
        // 통계 수집 실패 무시
      }
    }, 500);
  }
  
  /**
   * 🚀 [Phase 3] WebRTC 통계 수집 중지
   */
  private stopStatsCollection(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
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
    } else {
      this.stopStatsCollection();
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
    
    // 🚨 [핵심] 연결된 피어 ID 초기화
    this.connectedPeerId = null;
    
    // 🚀 [Phase 3] 추가 정리
    this.stopStatsCollection();
    this.networkController.reset();
    this.dataChannels.forEach(ch => ch.close());
    this.dataChannels = [];
  }
}

export const transferService = new EnhancedWebRTCService();
