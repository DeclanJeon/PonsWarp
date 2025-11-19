import SimplePeer from 'simple-peer';
import { signalingService } from './signaling';
import { getSenderWorkerV1, getReceiverWorkerV1 } from './workerFactory';
import { TransferManifest } from '../types';

type EventHandler = (data: any) => void;

class EnhancedWebRTCService {
  private peer: SimplePeer.Instance | null = null;
  private worker: Worker | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};
  private roomId: string | null = null;
  
  // Backpressure Control Variables
  private readonly MAX_BUFFERED_AMOUNT = 256 * 1024; // 256KB Limit (안전 제일)
  private readonly LOW_WATER_MARK = 64 * 1024;       // 64KB Resume
  private isPaused = false;
  private isTransferring = false;
  
  // 🚨 [추가] 전송 작업 줄 세우기용 변수
  private sendQueue: Promise<void> = Promise.resolve();

  constructor() {
    signalingService.on('offer', this.handleOffer.bind(this));
    signalingService.on('answer', this.handleAnswer.bind(this));
    signalingService.on('ice-candidate', this.handleIceCandidate.bind(this));
    signalingService.on('peer-joined', this.handlePeerJoined.bind(this));
  }

  public async connectSignaling() {
    await signalingService.connect();
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
    console.log('[Sender] Initializing with Serialized Queue Logic');
    this.cleanup();

    this.roomId = roomId;
    await this.connectSignaling();
    await this.joinRoom(roomId);

    this.worker = getSenderWorkerV1();
    
    // 워커 이벤트 핸들러
    this.worker.onmessage = (e) => {
      const { type, payload } = e.data;

      if (type === 'ready') {
        // 워커 준비 완료 -> 파일 리스트 전달
        this.worker!.postMessage({
          type: 'init',
          payload: { files, manifest }
        });
      }
      else if (type === 'chunk-ready') {
        // 🚨 [핵심 수정] 이전 작업이 끝난 뒤에 실행되도록 줄 세우기 (Chaining)
        this.sendQueue = this.sendQueue.then(async () => {
            try {
                await this.sendChunkWithBackpressure(payload.chunk, payload.progressData);
            } catch (err) {
                console.error('Chunk send error:', err);
                // 에러가 나도 체인이 끊기지 않게 처리
            }
        });
      }
      else if (type === 'complete') {
        // 🚨 [핵심 수정] 모든 청크 전송이 끝난 뒤에 EOF 전송
        this.sendQueue = this.sendQueue.then(async () => {
            console.log('[Sender] Data sent. Flushing buffer...');
            await this.waitForBufferZero();

            // 🚨 [핵심 수정] JSON 대신 "바이너리 EOS 패킷" 전송
            // 6바이트 헤더: [Index=65535 (2byte)] [Size=0 (4byte)]
            const eosPacket = new ArrayBuffer(6);
            const view = new DataView(eosPacket);
            view.setUint16(0, 0xFFFF, true); // Magic Number for EOF
            view.setUint32(2, 0, true);      // Payload Size 0

            console.log('[Sender] Sending Binary EOS packet.');
            this.peer?.send(eosPacket);
            
            this.emit('complete', true);
            this.isTransferring = false;
        });
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

    console.log('[Sender] Sending Manifest...');
    const manifestStr = JSON.stringify({
      type: 'MANIFEST',
      manifest: this.pendingManifest
    });
    this.peer.send(manifestStr);

    // 잠시 대기 후 바이너리 스트림 시작 (수신측 준비 시간 고려)
    setTimeout(() => {
      console.log('[Sender] Starting Binary Stream...');
      this.isTransferring = true;
      this.worker?.postMessage({ type: 'start' });
      this.emit('status', 'TRANSFERRING');
    }, 500);
  }

  // 🔥 Backpressure Core Logic (강화 버전)
  private async sendChunkWithBackpressure(chunk: ArrayBuffer, progressData: any) {
    if (!this.peer) return;

    // @ts-ignore
    const channel = this.peer._channel as RTCDataChannel;
    
    // 1. 안전장치: 채널이 닫혀있으면 중단
    if (channel.readyState !== 'open') {
        console.warn('Channel not open, skipping chunk');
        return;
    }

    // 2. 버퍼 체크 (High Water Mark)
    // 루프를 돌며 버퍼가 비워질 때까지 대기
    while (channel.bufferedAmount > this.MAX_BUFFERED_AMOUNT) {
      this.isPaused = true;
      await new Promise(resolve => setTimeout(resolve, 10)); // 10ms 간격으로 체크
    }
    this.isPaused = false;

    // 3. 전송 시도 (Try-Catch로 감싸서 에러 방어)
    try {
      this.peer.send(chunk);
      
      // 전송 성공 시에만 다음 단계 진행
      this.emit('progress', progressData);
      this.worker?.postMessage({ type: 'pull' });

    } catch (err: any) {
      // 🚨 Queue Full 에러 발생 시 재시도 로직
      if (err.name === 'OperationError' || err.message.includes('queue is full')) {
        console.warn('⚠️ Queue full detected, retrying in 50ms...');
        await new Promise(resolve => setTimeout(resolve, 50));
        // 재귀 호출로 다시 시도
        return this.sendChunkWithBackpressure(chunk, progressData);
      } else {
        console.error('🔥 Fatal Send Error:', err);
        this.emit('error', 'Transfer failed: ' + err.message);
      }
    }
  }

  // 🚨 버퍼가 0이 될 때까지 대기하는 함수
  private waitForBufferZero(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        // @ts-ignore
        const channel = this.peer?._channel as RTCDataChannel;
        
        if (!channel || channel.readyState !== 'open') {
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
    console.log('[Receiver] Initializing...');
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
        this.emit('complete', payload); // payload contains file/blob/opfs info
      } 
      else if (type === 'error') {
        this.emit('error', payload.error);
      }
    };

    this.emit('status', 'CONNECTING');
  }

  // ======================= PEER HANDLING =======================

  private async createPeer(initiator: boolean) {
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
      channelConfig: {
        ordered: true // 순서 보장 (필수)
        // 🚨 [삭제] maxRetransmits: 30  <-- 이 줄을 지워야 TCP처럼 100% 신뢰성 전송이 됨
      }
    });

    peer.on('signal', (data) => {
      if ('candidate' in data) signalingService.sendCandidate(this.roomId!, data);
      else if (data.type === 'offer') signalingService.sendOffer(this.roomId!, data);
      else if (data.type === 'answer') signalingService.sendAnswer(this.roomId!, data);
    });

    peer.on('connect', () => {
      console.log(`[${initiator ? 'Sender' : 'Receiver'}] Connected!`);
      this.emit('connected', true);
      if (initiator) {
        this.startTransferSequence();
      }
    });

    peer.on('data', (data) => this.handleReceivedData(data));
    peer.on('error', (err) => this.emit('error', err.message));
    peer.on('close', () => this.emit('error', 'Peer connection closed'));

    this.peer = peer;
  }

  private handleReceivedData(data: any) {
    // 1. JSON 처리 (MANIFEST만 처리, EOF는 제거)
    if (typeof data === 'string' || (data instanceof Uint8Array && data[0] === 123)) {
      try {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        if (text.indexOf('MANIFEST') > 0) {
            const msg = JSON.parse(text);
            if (msg.type === 'MANIFEST') {
              console.log('[Receiver] 📜 Manifest Received:', msg.manifest);
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
  public cleanup() {
    if (this.peer) { this.peer.destroy(); this.peer = null; }
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.isPaused = false;
    this.isTransferring = false;
    this.pendingManifest = null;
  }
}

export const transferService = new EnhancedWebRTCService();
