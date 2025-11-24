import SimplePeer from 'simple-peer/simplepeer.min.js';
import { signalingService, TurnConfigResponse } from './signaling';
import { getSenderWorkerV1 } from './workerFactory';
import { TransferManifest } from '../types';
import { logInfo, logError } from '../utils/logger';
import { HEADER_SIZE, MAX_BUFFERED_AMOUNT, LOW_WATER_MARK, BATCH_REQUEST_SIZE } from '../constants';

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
  private isProcessingBatch = false; // 현재 워커가 데이터를 준비중인가?
  private pendingManifest: TransferManifest | null = null;
  
  private iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  constructor() {
    signalingService.on('offer', this.handleOffer.bind(this));
    signalingService.on('answer', this.handleAnswer.bind(this));
    signalingService.on('ice-candidate', this.handleIceCandidate.bind(this));
    signalingService.on('peer-joined', this.handlePeerJoined.bind(this));
    
    // 🚨 [추가] Room Full 에러 처리
    signalingService.on('room-full', () => {
        this.emit('error', 'Room is full. Please try a different Room ID.');
        this.cleanup();
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
   * 🚀 [핵심 수정] Backpressure 기반 데이터 전송
   * setInterval 대신 channel.onbufferedamountlow 이벤트를 사용해야 함
   */
  private handleBatchFromWorker(payload: any) {
    if (!this.peer || this.peer.destroyed) return;
    
    // @ts-ignore
    const channel = this.peer._channel as RTCDataChannel;
    if (channel.readyState !== 'open') return;

    const { chunks, progressData } = payload;
    this.isProcessingBatch = false; // 배치 처리 완료 해제

    try {
        // 1. 청크 전송
        for (const chunk of chunks) {
            this.peer.send(chunk);
        }
        
        // 2. 진행률 방출
        this.emit('progress', progressData);

        // 3. 🚀 [핵심] 버퍼가 여유로우면 *즉시* 다음 배치 요청 (파이프라인 유지)
        if (channel.bufferedAmount < LOW_WATER_MARK) {
            this.requestMoreChunks();
        }
        // 버퍼가 찼다면? -> 아무것도 안 함.
        // channel.onbufferedamountlow 이벤트가 발생할 때 requestMoreChunks()가 호출됨.

    } catch (e) {
        console.error('Send failed:', e);
        this.cleanup();
    }
  }

  private requestMoreChunks() {
    if (this.isProcessingBatch || !this.worker || !this.isTransferring) return;
    
    this.isProcessingBatch = true;
    // BATCH_REQUEST_SIZE 만큼 요청 (약 1MB)
    this.worker.postMessage({ type: 'process-batch', payload: { count: BATCH_REQUEST_SIZE } });
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

    this.writer.onProgress((progress) => this.emit('progress', progress));
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
                console.log('[Sender] Receiver READY. Starting transfer...');
                this.isTransferring = true;
                this.requestMoreChunks(); // 첫 배치 요청
                this.emit('status', 'TRANSFERRING');
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

  public cleanup() {
    this.isTransferring = false;
    this.peer?.destroy();
    this.peer = null;
    this.worker?.terminate();
    this.worker = null;
    this.writer?.cleanup();
  }
}

export const transferService = new EnhancedWebRTCService();
