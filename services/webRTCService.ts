import SimplePeer from 'simple-peer/simplepeer.min.js';
import { signalingService } from './signaling';
import { getSenderWorkerV1, getReceiverWorkerV1 } from './workerFactory';
import { TransferManifest } from '../types';
import { logInfo, logWarn, logError } from '../utils/logger';
import { MAX_BUFFERED_AMOUNT } from '../constants';

type EventHandler = (data: any) => void;

class EnhancedWebRTCService {
  private peer: SimplePeer.Instance | null = null;
  private worker: Worker | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};
  private roomId: string | null = null;
  private isTransferring = false;

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
    this.roomId = roomId;
    await this.connectSignaling();
    await this.joinRoom(roomId);

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

  // 🚀 [최적화] 큐 없이 즉시 전송
  private handleChunkFromWorker(payload: any) {
    if (!this.peer) return;
    
    try {
      // @ts-ignore
      const channel = this.peer._channel as RTCDataChannel;
      
      // Backpressure: 버퍼가 꽉 차면 워커에게 감속 요청
      if (channel && channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        this.worker?.postMessage({ type: 'network-congestion' });
      }

      this.peer.send(payload.chunk);
      this.emit('progress', payload.progressData);

    } catch (e) {
      logWarn('[Sender]', 'Send failed, reducing window', e);
      this.worker?.postMessage({ type: 'network-congestion' });
    }
  }

  private startTransferSequence() {
    if (!this.peer || !this.pendingManifest) return;

    const manifestStr = JSON.stringify({ type: 'MANIFEST', manifest: this.pendingManifest });
    this.peer.send(manifestStr);

    // 수신자 준비 시간 약간 대기 후 시작
    setTimeout(() => {
      this.isTransferring = true;
      this.worker?.postMessage({ type: 'start' });
      this.emit('status', 'TRANSFERRING');
    }, 500);
  }

  private async finishTransfer() {
    await this.waitForBufferZero();
    
    // EOS 패킷 전송 (헤더 구조에 맞춰 10바이트)
    // [FileIndex: 0xFFFF] [Seq: 0] [Len: 0]
    const eosPacket = new ArrayBuffer(10);
    new DataView(eosPacket).setUint16(0, 0xFFFF, true); 
    this.peer?.send(eosPacket);
    
    logInfo('[Sender]', 'Transfer Complete');
    this.emit('complete', true);
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
    this.roomId = roomId;
    await this.connectSignaling();
    await this.joinRoom(roomId);

    this.worker = getReceiverWorkerV1();
    
    this.worker.onmessage = (e) => {
      const { type, payload } = e.data;
      
      if (type === 'ack') {
        // 🚀 수신한 Chunk Index를 Sender에게 반환 (필수)
        if (this.peer && !this.peer.destroyed) {
          const ackMsg = JSON.stringify({ type: 'ACK', chunkIndex: payload.chunkIndex });
          this.peer.send(ackMsg);
        }
      }
      else if (type === 'progress') this.emit('progress', payload);
      else if (type === 'complete') this.emit('complete', payload);
    };

    this.emit('status', 'CONNECTING');
  }

  // ======================= PEER HANDLING =======================

  private async createPeer(initiator: boolean) {
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
      channelConfig: { ordered: true } // 순서 보장 필수
    });

    peer.on('signal', data => {
      if (data.type === 'offer') signalingService.sendOffer(this.roomId!, data);
      else if (data.type === 'answer') signalingService.sendAnswer(this.roomId!, data);
      else if (data.candidate) signalingService.sendCandidate(this.roomId!, data);
    });

    peer.on('connect', () => {
      this.emit('connected', true);
      if (initiator) this.startTransferSequence();
    });

    peer.on('data', (data) => this.handleReceivedData(data));
    peer.on('error', e => { logError('Peer Error', e); this.emit('error', e); });
    peer.on('close', () => this.emit('error', 'Connection closed'));

    this.peer = peer;
  }

  private handleReceivedData(data: any) {
    // 1. JSON 텍스트 처리 (Manifest, ACK)
    if (data.toString().includes('"type"')) {
      try {
        const msg = JSON.parse(data.toString());
        
        // Sender가 받는 ACK -> Worker로 전달
        if (msg.type === 'ACK' && this.worker) {
          this.worker.postMessage({ type: 'ack-received', payload: { chunkIndex: msg.chunkIndex } });
          return;
        }

        // Receiver가 받는 Manifest
        if (msg.type === 'MANIFEST') {
          this.emit('metadata', msg.manifest);
          this.worker?.postMessage({ type: 'init-manifest', payload: msg.manifest });
          return;
        }
      } catch (e) {}
    }

    // 2. 바이너리 데이터 (청크) -> Receiver Worker로 전달
    if (this.worker) {
      const chunk = data instanceof Uint8Array ? data.buffer : data;
      // Transferable Object로 전달하여 복사 비용 제거
      this.worker.postMessage({ type: 'chunk', payload: chunk }, [chunk]);
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

  private handlePeerJoined = async () => { if (this.pendingManifest && !this.peer) await this.createPeer(true); };
  private handleOffer = async (d: any) => { if (!this.peer) await this.createPeer(false); this.peer!.signal(d.offer); };
  private handleAnswer = async (d: any) => { this.peer?.signal(d.answer); };
  private handleIceCandidate = (d: any) => { this.peer?.signal(d.candidate); };

  public cleanup() {
    this.peer?.destroy();
    this.peer = null;
    this.worker?.terminate();
    this.worker = null;
    this.isTransferring = false;
  }
}

export const transferService = new EnhancedWebRTCService();
