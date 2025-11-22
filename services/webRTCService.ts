import SimplePeer from 'simple-peer/simplepeer.min.js';
import { signalingService, TurnConfigResponse } from './signaling';
import { getSenderWorkerV1, getReceiverWorkerV1 } from './workerFactory';
import { TransferManifest } from '../types';
import { logInfo, logWarn, logError } from '../utils/logger';
import { HIGH_WATER_MARK, LOW_WATER_MARK, HEADER_SIZE, BATCH_SIZE } from '../constants';

type EventHandler = (data: any) => void;

// 🚀 [설정] 멀티 채널 개수 (4개가 최적 효율)
const NUM_CHANNELS = 4;
const MAX_QUEUE_SIZE = 100;

class EnhancedWebRTCService {
  private peer: SimplePeer.Instance | null = null;
  private worker: Worker | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};
  private roomId: string | null = null;
  private isTransferring = false;
  private isSender = false;
  
  // 🚀 [추가] 멀티 채널 관리 배열
  private channels: RTCDataChannel[] = [];
  
  private pendingQueue: ArrayBuffer[] = [];
  private isDraining = false;
  private awaitingReceiverComplete = false;
  
  // 🚨 [추가] 워커 일시정지 상태 추적용 플래그
  private isWorkerPaused = false;
  
  // 🚨 [추가] 핸드쉐이크 재전송용 타이머
  private handshakeInterval: any = null;
  
  // 🚨 [추가] 초기화 중복 방지용 플래그
  private isInitializing = false;
  
  // 🚨 [신규] 바이트 포맷 헬퍼
  
  private iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  constructor() {
    signalingService.on('offer', this.handleOffer.bind(this));
    signalingService.on('answer', this.handleAnswer.bind(this));
    signalingService.on('ice-candidate', this.handleIceCandidate.bind(this));
    signalingService.on('peer-joined', this.handlePeerJoined.bind(this));
  }

  public async connectSignaling() { await signalingService.connect(); }
  public generateRoomId() { this.roomId = Math.random().toString(36).substring(2, 8).toUpperCase(); return this.roomId; }
  public async joinRoom(roomId: string) { this.roomId = roomId; await signalingService.joinRoom(roomId); }

  // ======================= SENDER LOGIC =======================

  public async initSender(manifest: TransferManifest, files: File[], roomId: string) {
    logInfo('[Sender]', 'Initializing Multi-Channel Sender');
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
        // 🚨 [수정] payload에 config 추가하여 BATCH_SIZE 전달
        this.worker!.postMessage({
            type: 'init',
            payload: {
                files,
                manifest,
                config: { batchSize: BATCH_SIZE } // 모바일/PC에 따라 다른 값 전달됨
            }
        });
      }
      else if (type === 'chunk-batch') {
        this.handleBatchFromWorker(payload.chunks, payload.progressData);
      }
      else if (type === 'complete') {
        this.finishTransfer();
      }
    };

    this.emit('status', 'WAITING_FOR_PEER');
    this.pendingManifest = manifest;
  }

  private pendingManifest: TransferManifest | null = null;

  private handleBatchFromWorker(chunks: ArrayBuffer[], progressData: any) {
    if (!this.peer || this.peer.destroyed) return;

    if (this.pendingQueue.length > MAX_QUEUE_SIZE) {
      console.warn(`[Sender] Queue full. Pausing worker.`);
      this.worker?.postMessage({ type: 'pause' });
      this.pendingQueue.push(...chunks);
      this.checkDrain();
      return;
    }

    this.emit('progress', progressData);
    this.processSend(chunks);
  }

  // 🚀 [수정] 백프레셔 제어 로직 강화 (Deadlock 방지)
  private processSend(chunks: ArrayBuffer[]) {
    // 사용 가능한 채널이 없으면 대기
    const activeChannels = this.channels.filter(ch => ch.readyState === 'open');
    if (activeChannels.length === 0) {
      this.pendingQueue.push(...chunks);
      return;
    }

    // 전체 버퍼 체크
    if (this.pendingQueue.length > 0 || this.getTotalBufferedAmount() > HIGH_WATER_MARK) {
      this.pendingQueue.push(...chunks);
      
      // 🚨 [핵심] 워커가 이미 멈춰있으면 중복해서 pause 보내지 않음
      if (!this.isWorkerPaused) {
        console.warn(`[Sender] 🛑 Backpressure detected (Buffer: ${this.formatBytes(this.getTotalBufferedAmount())}). Pausing worker.`);
        this.worker?.postMessage({ type: 'pause' });
        this.isWorkerPaused = true;
      }
      
      this.checkDrain();
      return;
    }

    try {
      chunks.forEach((chunk, i) => {
        // 라운드 로빈: i번째 청크는 (i % 채널수)번째 채널로
        const channelIndex = i % activeChannels.length;
        const targetChannel = activeChannels[channelIndex];
        
        // 개별 채널 버퍼 체크 (안전장치)
        if (targetChannel.bufferedAmount > HIGH_WATER_MARK) {
           throw new Error('Channel buffer full');
        }
        targetChannel.send(chunk);
      });
    } catch (e) {
      // 실패 시 남은 청크들은 큐로
      console.warn('[Sender] Buffer full during direct send. Queueing remaining chunks.');
      
      // 🚨 [수정] 실패한 청크들만 큐에 저장 (전체 아님)
      const failedChunkIndex = chunks.findIndex((chunk, index) => {
        try {
          const channelIndex = index % activeChannels.length;
          const targetChannel = activeChannels[channelIndex];
          targetChannel.send(chunk);
          return false; // 성공
        } catch {
          return true; // 실패
        }
      });
      
      if (failedChunkIndex !== -1) {
        const failedChunks = chunks.slice(failedChunkIndex);
        this.pendingQueue.push(...failedChunks);
        console.warn(`[Sender] ${failedChunks.length} chunks failed, queued. Total pending: ${this.pendingQueue.length}`);
      }
      
      this.checkDrain();
    }
  }

  // 🚀 [신규] 모든 채널의 버퍼 합계 계산
  private getTotalBufferedAmount(): number {
    return this.channels.reduce((sum, ch) => sum + ch.bufferedAmount, 0);
  }

  // 🚀 [수정] 멀티 채널 드레인 체크 (Deadlock 방지)
  private checkDrain() {
    if (this.isDraining) return;
    
    console.log('[Sender] 💧 Starting drain process...');
    this.isDraining = true;
    
    // 단순화: 주기적으로 체크 (onbufferedamountlow는 여러 채널에서 튀므로 복잡함)
    const drainInterval = setInterval(() => {
        const totalBuffered = this.getTotalBufferedAmount();
        
        if (totalBuffered < LOW_WATER_MARK) {
            // 큐 비우기
            const processCount = Math.min(this.pendingQueue.length, MAX_QUEUE_SIZE);
            if (processCount > 0) {
                const batch = this.pendingQueue.splice(0, processCount);
                console.log(`[Sender] 💧 Draining ${processCount} chunks from queue. Remaining: ${this.pendingQueue.length}`);
                
                // 🚨 [수정] 큐에서 꺼낸 데이터는 직접 전송 시도
                this.trySendToChannels(batch);
            }
            
            if (this.pendingQueue.length === 0) {
                console.log('[Sender] ✅ Queue fully drained. Stopping drain process.');
                clearInterval(drainInterval);
                this.isDraining = false;
                
                // 🚨 [핵심] 워커 재개 조건 확인
                if (this.isWorkerPaused) {
                    console.log('[Sender] ▶️ Resuming worker (queue empty, buffer safe)');
                    this.worker?.postMessage({ type: 'start' });
                    this.isWorkerPaused = false;
                }
            }
        } else {
            console.log(`[Sender] 💧 Buffer still high (${this.formatBytes(totalBuffered)}). Continuing drain...`);
        }
    }, 50); // 50ms 마다 체크
  }

  // 🚨 [신규] 채널로 직접 전송 시도 (드레인 중복 방지)
  private trySendToChannels(chunks: ArrayBuffer[]) {
    const activeChannels = this.channels.filter(ch => ch.readyState === 'open');
    if (activeChannels.length === 0) {
        console.warn('[Sender] No active channels for direct send, re-queuing');
        this.pendingQueue.push(...chunks);
        return;
    }

    try {
        chunks.forEach((chunk, i) => {
            const channelIndex = i % activeChannels.length;
            const targetChannel = activeChannels[channelIndex];
            
            if (targetChannel.bufferedAmount > HIGH_WATER_MARK) {
                throw new Error('Channel buffer full during drain');
            }
            targetChannel.send(chunk);
        });
        
        console.log(`[Sender] 💧 Direct sent ${chunks.length} chunks successfully`);
    } catch (e) {
        console.warn('[Sender] Direct send failed, re-queuing chunks');
        this.pendingQueue.push(...chunks);
    }
  }

  // 🚨 [신규] 바이트 포맷 헬퍼
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  private async finishTransfer() {
    await this.waitForBufferZero();
    
    // EOS는 모든 채널에 보낼 필요 없음, 0번 채널로 전송
    const eosPacket = new ArrayBuffer(HEADER_SIZE);
    const view = new DataView(eosPacket);
    view.setUint16(0, 0xFFFF, true);
    
    if (this.channels[0] && this.channels[0].readyState === 'open') {
        this.channels[0].send(eosPacket);
    }
    
    this.awaitingReceiverComplete = true;
    this.emit('remote-processing', true);
    this.isTransferring = false;
  }

  private waitForBufferZero(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.getTotalBufferedAmount() === 0) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  // ======================= RECEIVER LOGIC =======================

  public async initReceiver(roomId: string) {
    logInfo('[Receiver]', 'Initializing Multi-Channel Receiver');
    this.cleanup();
    this.isSender = false;
    this.roomId = roomId;
    
    // 🚨 [추가] 상태 플래그 초기화
    this.isInitializing = false;
    
    await this.connectSignaling();
    await this.joinRoom(roomId);
    await this.fetchTurnConfig(roomId);

    this.worker = getReceiverWorkerV1();
    
    this.worker.onmessage = (e) => {
      const { type, payload } = e.data;
      
      if (type === 'progress') this.emit('progress', payload);
      else if (type === 'complete') this.emit('complete', payload);
      else if (type === 'storage-ready') {
        console.log('[Receiver] ✅ Storage Ready. Sending TRANSFER_READY signal.');
        if (this.channels.length > 0 && this.channels[0].readyState === 'open') {
           this.channels[0].send(JSON.stringify({ type: 'TRANSFER_READY' }));
        }
      }
      // 🚨 [추가] 워커 에러 감지 (디버깅용 필수)
      else if (type === 'error') {
        console.error('❌ [Receiver Worker Error]:', payload);
        this.isInitializing = false; // 에러 나면 다시 시도할 수 있게 풀어줌
        this.emit('error', 'Storage Init Failed: ' + payload);
      }
    };
    this.emit('status', 'CONNECTING');
  }

  private async fetchTurnConfig(roomId: string) {
    try {
      const response: TurnConfigResponse = await signalingService.requestTurnConfig(roomId);
      
      if (response.success && response.data) {
        this.iceServers = response.data.iceServers;
      }
    } catch (error) {
      // TURN config fetch failed, using default STUN
    }
  }

  // ======================= PEER HANDLING =======================

  private async createPeer(initiator: boolean) {
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: { iceServers: this.iceServers },
    } as any); 

    // 🚀 [핵심] 피어 생성 시점
    if (initiator) {
        console.log('[WebRTC] Initiator: Creating multiple data channels...');
        // 연결 전에는 _pc가 없을 수 있으므로 'connect'나 signaling 단계가 아닌,
        // SimplePeer 인스턴스 생성 직후 _pc에 접근하여 채널 생성
        // @ts-ignore
        const pc = peer._pc as RTCPeerConnection;
        
        // 기존 channels 초기화
        this.channels = [];
        
        for (let i = 0; i < NUM_CHANNELS; i++) {
            // ordered: true로 설정하여 각 채널 내에서는 순서 보장 (패킷 손실 방지)
            const channel = pc.createDataChannel(`warp-channel-${i}`, { ordered: true });
            channel.binaryType = 'arraybuffer';
            this.setupChannel(channel);
            this.channels.push(channel);
        }
    } else {
        // Receiver는 ondatachannel 이벤트를 통해 채널을 받아야 함
        // simple-peer는 기본 채널 외의 채널 이벤트를 래핑해주지 않으므로 _pc에 직접 접근
        // @ts-ignore
        const pc = peer._pc as RTCPeerConnection;
        
        pc.ondatachannel = (event) => {
            const channel = event.channel;
            
            // 🚨 [핵심 수정] SimplePeer 기본 채널(유령 채널) 무시
            // 우리가 만든 'warp-channel-X'로 시작하는 채널만 등록
            if (!channel.label.startsWith('warp-channel-')) {
                console.log(`[WebRTC] Receiver: Ignoring default channel: ${channel.label}`);
                return;
            }

            console.log(`[WebRTC] Receiver: Data channel accepted: ${channel.label}`);
            channel.binaryType = 'arraybuffer';
            this.setupChannel(channel);
            this.channels.push(channel);
        };
    }

    peer.on('signal', data => {
       if (data.type === 'offer') signalingService.sendOffer(this.roomId!, data);
       else if (data.type === 'answer') signalingService.sendAnswer(this.roomId!, data);
       else if (data.candidate) signalingService.sendCandidate(this.roomId!, data);
    });

    peer.on('connect', () => {
      console.log(`[WebRTC] Peer Connected. Active channels: ${this.channels.length}`);
      this.emit('connected', true);
      
      if (initiator) {
        // 🚨 [수정] 모든 채널이 열릴 때까지 대기 로직 강화
        console.log('[WebRTC] Initiator: Waiting for all channels to open...');
        
        // 채널 상태 확인 함수
        const checkAllChannelsOpen = () => {
          const allOpen = this.channels.length === NUM_CHANNELS &&
                         this.channels.every(ch => ch.readyState === 'open');
          
          console.log(`[WebRTC] Channel status check: ${this.channels.filter(ch => ch.readyState === 'open').length}/${NUM_CHANNELS} open`);
          
          if (allOpen) {
            console.log('[WebRTC] ✅ All channels open! Starting transfer sequence...');
            setTimeout(() => this.startTransferSequence(), 100);
          } else {
            // 100ms마다 다시 확인
            setTimeout(checkAllChannelsOpen, 100);
          }
        };
        
        // 100ms 후에 첫 확인 시작
        setTimeout(checkAllChannelsOpen, 100);
      }
    });

    peer.on('error', e => {
      logError('Peer Error', e);
      this.emit('error', e.message || e);
    });
    
    peer.on('close', () => this.emit('error', 'Connection closed'));

    this.peer = peer;
  }

  // 🚀 [신규] 채널 공통 설정 (이벤트 리스너 부착)
  private setupChannel(channel: RTCDataChannel) {
      channel.onopen = () => {
          console.log(`[WebRTC] Channel '${channel.label}' OPEN (${this.channels.filter(ch => ch.readyState === 'open').length}/${NUM_CHANNELS} total)`);
          
          // 🚨 [추가] 모든 채널이 열렸는지 확인
          if (this.channels.length === NUM_CHANNELS &&
              this.channels.every(ch => ch.readyState === 'open')) {
              console.log('[WebRTC] ✅ All channels are now open!');
          }
      };
      
      channel.onerror = (error) => {
          console.error(`[WebRTC] Channel '${channel.label}' Error:`, error);
      };

      channel.onmessage = (event) => {
          this.handleIncomingData(event.data);
      };
  }

  // 🚀 [수정] 수신 데이터 처리 로직 개선 (데이터 타입 불일치 해결)
  private handleIncomingData(data: any) {
      // 1. 데이터 타입 정규화 (ArrayBuffer -> Uint8Array 변환)
      let asUint8: Uint8Array | null = null;
      const isString = typeof data === 'string';

      if (!isString) {
          if (data instanceof Uint8Array) {
              asUint8 = data;
          } else if (data instanceof ArrayBuffer) {
              asUint8 = new Uint8Array(data);
          }
      }

      // 2. JSON 제어 메시지 감지 로직
      // 문자열이거나, 바이너리 데이터의 첫 바이트가 '{' (ASCII 123)인 경우
      const isJsonPotential = isString || (asUint8 && asUint8.byteLength < 4096 && asUint8[0] === 123);

      if (isJsonPotential) {
          try {
              const str = isString ? data : new TextDecoder().decode(asUint8!);
              const msg = JSON.parse(str);
              
              // [디버그] 제어 메시지 수신 확인 (청크 로그 제외)
              if (msg.type !== 'CHUNK') {
                 console.log(`[WebRTC] 📩 Control Message Received: ${msg.type}`);
              }

              if (msg.type === 'MANIFEST') {
                  // 🚨 [핵심 수정] 이미 초기화 중이거나 전송 중이면 무시 (Idempotency)
                  if (this.isInitializing || this.isTransferring) {
                    console.warn('[Receiver] Ignoring duplicate Manifest (Already initializing)');
                    return;
                  }

                  console.log('[Receiver] 📥 Manifest Received via Multi-Channel.');
                  this.isInitializing = true;
                  this.emit('metadata', msg.manifest);
                  this.worker?.postMessage({ type: 'init-manifest', payload: msg.manifest });
                  return;
              }
              
              if (msg.type === 'DOWNLOAD_COMPLETE') {
                   if (this.awaitingReceiverComplete) {
                      console.log('[Sender] ✅ Download Complete confirmed by Receiver');
                      this.awaitingReceiverComplete = false;
                      this.emit('complete', true);
                   }
                   return;
              }
              
              if (msg.type === 'TRANSFER_READY') {
                  console.log('[Sender] 🚀 Receiver is READY! Stopping handshake & Starting transfer.');
                  
                  // 🚨 핸드쉐이크 타이머 종료
                  if (this.handshakeInterval) {
                    clearInterval(this.handshakeInterval);
                    this.handshakeInterval = null;
                  }
                  
                  if (!this.isTransferring) {
                    this.isTransferring = true;
                    this.emit('status', 'TRANSFERRING');
                    this.worker?.postMessage({ type: 'start' });
                  }
                  return;
              }
          } catch (e) {
              // JSON 파싱 실패 시 파일 데이터로 간주하고 아래로 진행
              console.warn('[WebRTC] JSON parse failed, treating as binary chunk:', e);
          }
      }

      // 3. 바이너리 청크 처리 (워커로 전달)
      // 위의 제어 메시지가 아닌 모든 데이터는 파일 청크임
      if (asUint8 || data instanceof ArrayBuffer) {
          // Transferable 객체로 보내야 성능이 최적화됨 (복사 방지)
          const buffer = data instanceof ArrayBuffer ? data : asUint8!.buffer;
          
          if (this.worker) {
              this.worker.postMessage({ type: 'chunk', payload: buffer }, [buffer as ArrayBuffer]);
          }
      }
  }

  // 🚀 [수정] Manifest 전송을 신뢰성 있게 변경 (Retry Logic)
  private startTransferSequence() {
    if (!this.channels[0] || !this.pendingManifest) {
      console.error('[WebRTC] Cannot start transfer: No channel or manifest');
      return;
    }

    // 🚨 [추가] 채널 상태 상세 확인
    const openChannels = this.channels.filter(ch => ch.readyState === 'open');
    console.log(`[WebRTC] Starting transfer sequence. Open channels: ${openChannels.length}/${NUM_CHANNELS}`);
    
    if (openChannels.length === 0) {
      console.error('[WebRTC] ❌ No channels open! Cannot start transfer.');
      return;
    }

    if (this.handshakeInterval) clearInterval(this.handshakeInterval);

    logInfo('[Sender]', 'Starting Handshake Sequence...');
    this.emit('status', 'WAITING_FOR_RECEIVER');

    const manifestData = JSON.stringify({ type: 'MANIFEST', manifest: this.pendingManifest });

    // 1초마다 Manifest를 0번 채널로 쏨 (상대방이 응답할 때까지)
    this.handshakeInterval = setInterval(() => {
      if (this.isTransferring) {
        clearInterval(this.handshakeInterval);
        return;
      }
      
      // 🚨 [수정] 채널 상태 재확인
      if (this.channels[0] && this.channels[0].readyState === 'open') {
        console.log('[Sender] 📡 Sending Manifest (Handshake Retry)...');
        this.channels[0].send(manifestData);
      } else {
        console.warn('[Sender] ⚠️ Channel 0 not ready, skipping this retry');
      }
    }, 1000);
  }

  public notifyDownloadComplete() {
      if (this.channels[0] && this.channels[0].readyState === 'open') {
          this.channels[0].send(JSON.stringify({ type: 'DOWNLOAD_COMPLETE' }));
      }
  }

  public cleanup() {
    if (this.handshakeInterval) clearInterval(this.handshakeInterval); // 🚨 추가
    this.peer?.destroy();
    this.peer = null;
    this.worker?.terminate();
    this.worker = null;
    this.isTransferring = false;
    this.isSender = false;
    this.isInitializing = false; // 🚨 리셋
    this.channels = []; // 채널 목록 초기화
    this.pendingQueue = [];
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

  private handlePeerJoined = async () => { if (this.pendingManifest && !this.peer) await this.createPeer(true); };
  private handleOffer = async (d: any) => { if (!this.peer) await this.createPeer(false); this.peer!.signal(d.offer); };
  private handleAnswer = async (d: any) => { this.peer?.signal(d.answer); };
  private handleIceCandidate = (d: any) => { this.peer?.signal(d.candidate); };
}

export const transferService = new EnhancedWebRTCService();
