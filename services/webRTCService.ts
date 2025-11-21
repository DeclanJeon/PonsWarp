import SimplePeer from 'simple-peer/simplepeer.min.js';
import { signalingService, TurnConfigResponse } from './signaling';
import { getSenderWorkerV1, getReceiverWorkerV1 } from './workerFactory';
import { TransferManifest } from '../types';
import { logInfo, logWarn, logError } from '../utils/logger';
import { MAX_BUFFERED_AMOUNT, HEADER_SIZE } from '../constants';

type EventHandler = (data: any) => void;

class EnhancedWebRTCService {
  private peer: SimplePeer.Instance | null = null;
  private worker: Worker | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};
  private roomId: string | null = null;
  private isTransferring = false;
  private isSender = false; // 🚨 [추가] Sender/Receiver 구분
  
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
    logInfo('[Sender]', 'Initializing Enhanced Sender');
    this.cleanup();
    this.isSender = true; // 🚨 [추가] Sender로 설정
    this.roomId = roomId;
    await this.connectSignaling();
    await this.joinRoom(roomId);

    await this.fetchTurnConfig(roomId);

    this.worker = getSenderWorkerV1();
    
    this.worker.onmessage = (e) => {
      const { type, payload } = e.data;

      if (type === 'ready') {
        this.worker!.postMessage({ type: 'init', payload: { files, manifest } });
      }
      else if (type === 'chunk-ready') {
        this.handleChunkFromWorker(payload);
      }
      else if (type === 'complete') {
        this.finishTransfer();
      }
    };

    this.emit('status', 'WAITING_FOR_PEER');
    this.pendingManifest = manifest;
  }

  private pendingManifest: TransferManifest | null = null;

  private handleChunkFromWorker(payload: any) {
    if (!this.peer || this.peer.destroyed) {
      // console.warn('[Sender] Peer destroyed, stopping worker');
      this.worker?.postMessage({ type: 'pause' });
      return;
    }
    
    try {
      // @ts-ignore
      const channel = this.peer._channel as RTCDataChannel;
      
      // 🚨 [핵심 수정] 버퍼가 가득 찬 경우 전송 중단
      if (channel && channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        // console.warn('[Sender] Buffer full, pausing. Buffered:', channel.bufferedAmount);
        this.worker?.postMessage({ type: 'network-congestion' });
        this.worker?.postMessage({ type: 'pause' });
        
        // 버퍼가 비워질 때까지 대기 후 재개
        const waitForBuffer = () => {
          if (this.peer && !this.peer.destroyed && channel.bufferedAmount < MAX_BUFFERED_AMOUNT / 2) {
            // console.log('[Sender] Buffer cleared, resuming');
            this.worker?.postMessage({ type: 'start' });
          } else if (this.peer && !this.peer.destroyed) {
            setTimeout(waitForBuffer, 100);
          }
        };
        setTimeout(waitForBuffer, 100);
        return; // 전송 중단
      }

      this.peer.send(payload.chunk);
      this.emit('progress', payload.progressData);

    } catch (e) {
      logWarn('[Sender]', 'Send failed, stopping worker', e);
      this.worker?.postMessage({ type: 'pause' });
    }
  }

  private startTransferSequence() {
    if (!this.peer || !this.pendingManifest) return;

    this.peer.send(JSON.stringify({ type: 'MANIFEST', manifest: this.pendingManifest }));

    setTimeout(() => {
      this.isTransferring = true;
      this.worker?.postMessage({ type: 'start' });
      this.emit('status', 'TRANSFERRING');
    }, 600);
  }

  private async finishTransfer() {
    await this.waitForBufferZero();
    
    // 🚨 [수정] EOS 패킷 크기 수정 (10 -> HEADER_SIZE)
    // 수신 측 워커는 HEADER_SIZE(18)보다 작은 패킷은 무시하므로 크기를 맞춰야 함
    const eosPacket = new ArrayBuffer(HEADER_SIZE);
    const view = new DataView(eosPacket);
    
    // FileIndex: 0xFFFF (종료 신호)
    view.setUint16(0, 0xFFFF, true);
    
    // 나머지 필드(ChunkIndex, Offset, DataLen)는 0으로 둬도 무방함
    
    this.peer?.send(eosPacket);
    
    logInfo('[Sender]', 'All chunks sent. Waiting for receiver confirmation.');
    
    this.emit('remote-processing', true);
    this.isTransferring = false;
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

  public async initReceiver(roomId: string) {
    this.cleanup();
    this.isSender = false; // 🚨 [추가] Receiver로 설정
    this.roomId = roomId;
    await this.connectSignaling();
    await this.joinRoom(roomId);

    await this.fetchTurnConfig(roomId);

    this.worker = getReceiverWorkerV1();
    
    this.worker.onmessage = (e) => {
      const { type, payload } = e.data;
      
      if (type === 'ack') {
        // 💡 [수정] Worker에서 받은 seq를 Sender에게 전송
        if (this.peer && !this.peer.destroyed) {
          const ackMsg = JSON.stringify({
            type: 'ACK',
            seq: payload.seq // chunkIndex -> seq 변경
          });
          this.peer.send(ackMsg);
        }
      }
      else if (type === 'progress') this.emit('progress', payload);
      else if (type === 'complete') this.emit('complete', payload);
    };

    this.emit('status', 'CONNECTING');
  }

  private async fetchTurnConfig(roomId: string) {
    try {
      // console.log('[WebRTC] Requesting TURN config from server...');
      const response: TurnConfigResponse = await signalingService.requestTurnConfig(roomId);
      
      if (response.success && response.data) {
        this.iceServers = response.data.iceServers;
        // console.log('[WebRTC] ✅ Applied TURN servers:', this.iceServers);
      }
    } catch (error) {
      // console.warn('[WebRTC] ⚠️ Failed to fetch TURN config, using default STUN:', error);
    }
  }

  // ======================= PEER HANDLING =======================

  private async createPeer(initiator: boolean) {
    // console.log('[WebRTC] Creating Peer with ICE Servers:', this.iceServers);

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: { iceServers: this.iceServers },
      channelConfig: { ordered: true },
    } as any); 

    const forceArrayBuffer = () => {
      // @ts-ignore
      if (peer._channel && peer._channel.binaryType !== 'arraybuffer') {
        // @ts-ignore
        peer._channel.binaryType = 'arraybuffer';
        // console.log('[WebRTC] Forced binaryType = arraybuffer');
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
      this.emit('connected', true);
      if (initiator) this.startTransferSequence();
    });

    peer.on('data', (data: any) => {
      // 🚨 [진단] 수신 데이터 타입 및 크기 로깅
      const dataType = data instanceof ArrayBuffer ? 'ArrayBuffer' :
                       data instanceof Uint8Array ? 'Uint8Array' :
                       typeof data === 'string' ? 'String' :
                       typeof data;
      const dataSize = data instanceof ArrayBuffer ? data.byteLength :
                       data instanceof Uint8Array ? data.byteLength :
                       typeof data === 'string' ? data.length : 0;
      
      // console.log('[WebRTC] Data received:', {
      //   type: dataType,
      //   size: dataSize,
      //   isString: typeof data === 'string',
      //   firstBytes: data instanceof Uint8Array ? Array.from(data.slice(0, 4)) : 'N/A'
      // });

      // 1. JSON 메시지 처리 (Manifest, ACK, DOWNLOAD_COMPLETE)
      // 🚨 [핵심 수정] Uint8Array가 JSON일 수 있음 - 먼저 JSON 파싱 시도
      if (typeof data === 'string') {
        try {
          // console.log('[WebRTC] Parsing as JSON string');
          const msg = JSON.parse(data);
          
          if (msg.type === 'ACK' && this.worker && this.isSender) {
            // console.log('[WebRTC] ACK received:', msg.seq);
            this.worker.postMessage({ type: 'ack-received', payload: { seq: msg.seq } });
            return;
          }
          if (msg.type === 'MANIFEST') {
            // console.log('[WebRTC] MANIFEST received');
            this.emit('metadata', msg.manifest);
            this.worker?.postMessage({ type: 'init-manifest', payload: msg.manifest });
            return;
          }
          if (msg.type === 'DOWNLOAD_COMPLETE') {
            logInfo('[Sender]', 'Receiver confirmed download complete!');
            this.emit('complete', true);
            return;
          }
        } catch (e) {
          // console.warn('[WebRTC] Failed to parse JSON string:', e);
        }
        return; // String이면 바이너리가 아니므로 여기서 종료
      }

      // 🚨 [핵심 수정] Uint8Array가 JSON인지 먼저 확인
      if (data instanceof Uint8Array) {
        // JSON인지 확인: 첫 바이트가 { (123) 또는 [ (91)이면 JSON 가능성
        const firstByte = data[0];
        if (firstByte === 123 || firstByte === 91) { // '{' or '['
          try {
            const textDecoder = new TextDecoder();
            const jsonString = textDecoder.decode(data);
            const msg = JSON.parse(jsonString);
            
            // console.log('[WebRTC] Parsed Uint8Array as JSON:', msg.type);
            
            if (msg.type === 'ACK' && this.worker && this.isSender) {
              // console.log('[WebRTC] ACK received:', msg.seq);
              this.worker.postMessage({ type: 'ack-received', payload: { seq: msg.seq } });
              return;
            }
            if (msg.type === 'MANIFEST') {
              // console.log('[WebRTC] MANIFEST received from Uint8Array');
              this.emit('metadata', msg.manifest);
              this.worker?.postMessage({ type: 'init-manifest', payload: msg.manifest });
              return;
            }
            if (msg.type === 'DOWNLOAD_COMPLETE') {
              logInfo('[Sender]', 'Receiver confirmed download complete!');
              this.emit('complete', true);
              return;
            }
          } catch (e) {
            // JSON 파싱 실패 - 바이너리 청크로 처리
            // console.log('[WebRTC] Not JSON, treating as binary chunk');
          }
        }
      }

      // 2. 바이너리 청크 처리
      let chunk: ArrayBuffer;

      if (data instanceof ArrayBuffer) {
        // console.log('[WebRTC] Processing ArrayBuffer chunk');
        chunk = data;
      } else if (data instanceof Uint8Array) {
        // console.log('[WebRTC] Processing Uint8Array chunk:', {
        //   byteOffset: data.byteOffset,
        //   byteLength: data.byteLength,
        //   bufferLength: data.buffer.byteLength
        // });
        
        // 🚨 [진단] 버퍼 복사 전후 비교
        chunk = (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength);
        // console.log('[WebRTC] Copied chunk size:', chunk.byteLength);
      } else {
        // console.error('[WebRTC] ⚠️ Unknown data type received:', typeof data);
        return;
      }

      // 🚨 [진단] Worker에 전달하기 전 청크 정보 로깅
      // console.log('[WebRTC] Sending chunk to worker:', {
      //   chunkSize: chunk.byteLength,
      //   firstByte: new Uint8Array(chunk)[0],
      //   lastByte: new Uint8Array(chunk)[chunk.byteLength - 1]
      // });

      // Transferable로 Worker에 전달 (Zero-copy)
      this.worker?.postMessage({ type: 'chunk', payload: chunk }, [chunk]);
    });

    peer.on('error', e => {
      logError('Peer Error', e);
      this.emit('error', e.message || e);
    });

    peer.on('close', () => this.emit('error', 'Connection closed'));

    this.peer = peer;
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

  public notifyDownloadComplete() {
    if (this.peer && !this.peer.destroyed) {
      // console.log('[Receiver] Sending DOWNLOAD_COMPLETE signal to sender');
      const msg = JSON.stringify({ type: 'DOWNLOAD_COMPLETE' });
      this.peer.send(msg);
    }
  }

  public cleanup() {
    this.peer?.destroy();
    this.peer = null;
    this.worker?.terminate();
    this.worker = null;
    this.isTransferring = false;
    this.isSender = false; // 🚨 [추가] 역할 리셋
  }
}

export const transferService = new EnhancedWebRTCService();
