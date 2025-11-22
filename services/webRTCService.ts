import SimplePeer from 'simple-peer/simplepeer.min.js';
import { signalingService, TurnConfigResponse } from './signaling';
import { getSenderWorkerV1, getReceiverWorkerV1 } from './workerFactory';
import { TransferManifest } from '../types';
import { logInfo, logWarn, logError } from '../utils/logger';
import { HIGH_WATER_MARK, LOW_WATER_MARK, HEADER_SIZE, BATCH_SIZE } from '../constants';

type EventHandler = (data: any) => void;

// 🚨 [설정] 큐 제한 설정 (메모리 폭발 방지)
// 100개 * 64KB = 약 6.4MB까지만 메모리에 허용
const MAX_QUEUE_SIZE = 100;

class EnhancedWebRTCService {
  private peer: SimplePeer.Instance | null = null;
  private worker: Worker | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};
  private roomId: string | null = null;
  private isTransferring = false;
  private isSender = false; // 🚨 [추가] Sender/Receiver 구분
  
  // 🚀 [추가] 전송 실패한 청크를 잠시 보관할 큐
  private pendingQueue: ArrayBuffer[] = [];
  private isDraining = false; // 현재 버퍼 비우기 대기 중인지 여부
  
  // 🚨 [추가] 송신자가 모든 청크 전송 완료 후 수신자의 완료 신호를 기다리기 위한 플래그
  private awaitingReceiverComplete = false;
  
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
      else if (type === 'chunk-batch') {
        // 🚀 [수정] 단일 chunk가 아니라 chunk-batch 처리
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

  // 🚀 [수정] 배치 전송 핸들러
  private handleBatchFromWorker(chunks: ArrayBuffer[], progressData: any) {
    if (!this.peer || this.peer.destroyed) return;

    // 1. 큐가 너무 많으면 "워커 정지" 명령 후 리턴
    // (메인 스레드 부하 방지 핵심: 큐가 넘치면 아예 처리를 미룸)
    if (this.pendingQueue.length > MAX_QUEUE_SIZE) {
      console.warn(`[Sender] ⚠️ Queue full (${this.pendingQueue.length}). Pausing worker.`);
      
      // 워커에게 "멈춰!" 신호 전송
      this.worker?.postMessage({ type: 'pause' });
      
      // 받은 데이터는 버리지 않고 큐에 저장
      this.pendingQueue.push(...chunks);
      
      // 배수 시스템(Drain) 가동
      const channel = this.peer._channel as RTCDataChannel;
      if (channel) this.setupDrainHandler(channel);
      
      return;
    }

    // 2. 정상 범위라면 UI 업데이트 및 전송 시도
    // (진행률은 여기서 업데이트해야 사용자가 "전송 중"임을 알 수 있음)
    this.emit('progress', progressData);
    console.log('[Sender] Progress emitted from worker batch:', progressData.progress.toFixed(1) + '%');
    
    // 실제 전송 로직 호출
    this.processSend(chunks);
  }

  // 🚀 [수정] 실제 전송 및 흐름 제어
  private processSend(chunks: ArrayBuffer[]) {
    // @ts-ignore
    const channel = this.peer?._channel as RTCDataChannel;
    
    // 채널 상태 체크
    if (!channel || channel.readyState !== 'open') {
      this.pendingQueue.push(...chunks);
      return;
    }

    // 3. 네트워크 버퍼가 찼거나, 이미 큐에 밀린 게 있다면 -> "전송 중단 & 큐 적재"
    if (this.pendingQueue.length > 0 || channel.bufferedAmount > HIGH_WATER_MARK) {
      this.pendingQueue.push(...chunks);
      
      if (this.worker) this.worker.postMessage({ type: 'pause' });
      this.setupDrainHandler(channel);
      return;
    }

    // 4. 쾌적한 상태라면 -> "즉시 전송"
    try {
      for (const chunk of chunks) {
        // 루프 도는 중에도 버퍼 체크 (안전장치)
        if (channel.bufferedAmount > HIGH_WATER_MARK) {
           throw new Error('Buffer full');
        }
        this.peer.send(chunk);
      }
    } catch (e) {
      // 보내다 막히면 나머지는 큐에 넣고 드레인 모드 전환
      console.log('[Sender] Buffer filled up. Switching to queue mode.');
      this.pendingQueue.push(...chunks);
      this.worker?.postMessage({ type: 'pause' });
      this.setupDrainHandler(channel);
    }
  }

  // 🚀 [신규] 새 청크 전송 헬퍼 메서드
  private sendNewChunks(chunks: ArrayBuffer[], progressData?: any, channel?: RTCDataChannel) {
    if (!channel) {
      // @ts-ignore
      channel = this.peer?._channel as RTCDataChannel;
    }
    
    if (!channel || channel.readyState !== 'open') {
      console.log('[Sender] Cannot send new chunks - channel not ready');
      return;
    }

    try {
      let sentCount = 0;
      for (const chunk of chunks) {
        if (channel.bufferedAmount > HIGH_WATER_MARK) {
          console.log('[Sender] Buffer exceeded, throwing error at chunk', sentCount, 'of', chunks.length);
          throw new Error('Buffer full during new chunk send');
        }
        this.peer.send(chunk);
        sentCount++;
      }
      
      // 🚨 [핵심 수정] 모두 성공했다면 진행률 업데이트
      if (progressData) {
        console.log('[Sender] All chunks sent successfully, emitting progress:', progressData.progress.toFixed(1) + '%');
        this.emit('progress', progressData);
      }
      
      console.log('[Sender] New chunks sent successfully:', sentCount, 'chunks');
    } catch (error) {
      console.log('[Sender] Buffer full during send, queuing chunks. Current buffered:', channel.bufferedAmount, 'HIGH_WATER_MARK:', HIGH_WATER_MARK);
      this.pendingQueue.push(...chunks);
      this.worker?.postMessage({ type: 'pause' });
      this.setupDrainHandler(channel);
    }
  }

  // 🚀 [수정] 드레인 핸들러 (큐 비우기 로직)
  private setupDrainHandler(channel: RTCDataChannel) {
    if (this.isDraining) return;
    this.isDraining = true;
    
    // 버퍼가 이 밑으로 떨어져야 다시 전송 시작
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
    
    channel.onbufferedamountlow = () => {
      // 1. 네트워크 공간이 생김 -> 큐에 있는거 밀어넣기
      // 한 번에 너무 많이 보내면 또 막히므로 적당히(MAX_QUEUE_SIZE만큼) 보냄
      const processCount = Math.min(this.pendingQueue.length, MAX_QUEUE_SIZE);
      
      if (processCount > 0) {
         // 큐에서 꺼내서 전송
         const batch = this.pendingQueue.splice(0, processCount);
         try {
           for (const chunk of batch) {
             this.peer!.send(chunk);
           }
           console.log(`[Sender] Drained ${batch.length} chunks. Remaining: ${this.pendingQueue.length}`);
         } catch (e) {
           // 보내다가 또 실패하면 다시 맨 앞에 쑤셔넣음 (Unshift)
           console.warn('[Sender] Drain failed, putting back to queue');
           this.pendingQueue.unshift(...batch);
           return; // 다음 low 이벤트 대기
         }
      }

      // 2. 상태 점검
      if (this.pendingQueue.length === 0) {
        // 큐가 싹 비워짐 -> 워커 다시 가동!
        console.log('[Sender] Queue drained completely. Resuming worker.');
        this.isDraining = false;
        channel.onbufferedamountlow = null; // 핸들러 해제
        this.worker?.postMessage({ type: 'start' });
      } else {
        // 아직 큐에 남았으면 -> 핸들러 유지하고 계속 비우기 시도
        // (onbufferedamountlow는 threshold 이하일 때 반복 호출되지 않을 수 있으므로
        //  버퍼가 이미 낮다면 수동으로 다시 트리거해야 할 수도 있음)
        if (channel.bufferedAmount < LOW_WATER_MARK) {
           // 재귀 호출 대신 약간의 지연 후 다시 체크
           setTimeout(() => {
              if (this.isDraining && channel.onbufferedamountlow) {
                  channel.onbufferedamountlow(new Event('bufferedamountlow'));
              }
           }, 10);
        }
      }
    };
  }

  // 백프레셔 상태 체크용 (단순화 - 더 이상 사용하지 않음)
  private checkBackpressure() {
    // 이 메서드는 더 이상 사용하지 않음 (processSend에서 모두 처리)
    console.log('[Sender] checkBackpressure called (deprecated)');
  }

  private startTransferSequence() {
    if (!this.peer || !this.pendingManifest) {
      console.error('[Sender] Cannot start transfer sequence - peer or manifest missing');
      return;
    }

    // Manifest 전송
    const manifestData = JSON.stringify({ type: 'MANIFEST', manifest: this.pendingManifest });
    console.log('[Sender] Sending Manifest:', manifestData.length, 'bytes');
    console.log('[Sender] Data channel state before send:', this.peer._channel?.readyState);
    
    try {
      this.peer.send(manifestData);
      console.log('[Sender] Manifest sent successfully');
    } catch (error) {
      console.error('[Sender] Failed to send manifest:', error);
      return;
    }

    this.emit('status', 'WAITING_FOR_RECEIVER'); // 상태 업데이트
    console.log('[Sender] Manifest sent, waiting for TRANSFER_READY signal');
    // 🚨 setTimeout 삭제함. 이제 수신자의 응답을 기다림.
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
    
    // 🚨 [핵심 수정] 수신자의 완료 신호를 기다리기 (DOWNLOAD_COMPLETE)
    // 이제 이 상태에서 수신자로부터 DOWNLOAD_COMPLETE 신호를 기다린다.
    // 수신자가 모든 파일을 저장하고 신호를 보낼 때까지 기다린다.
    this.awaitingReceiverComplete = true;
    this.emit('remote-processing', true);
    // 🚨 [중요] 여기서는 complete 이벤트를 발생시키지 않는다!
    // DOWNLOAD_COMPLETE 신호를 받은 후에 발생시킨다.
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
    console.log('[Receiver] Initializing receiver for room:', roomId);
    this.cleanup();
    this.isSender = false; // 🚨 [추가] Receiver로 설정
    this.roomId = roomId;
    await this.connectSignaling();
    await this.joinRoom(roomId);

    await this.fetchTurnConfig(roomId);

    this.worker = getReceiverWorkerV1();
    console.log('[Receiver] Worker created');
    
    this.worker.onmessage = (e) => {
      const { type, payload } = e.data;
      console.log('[Receiver] Message from worker:', type);
      
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
      // 🚨 [추가] 워커가 저장소 준비 완료를 알리면 -> 송신자에게 "데이터 보내!" 신호 전송
      else if (type === 'storage-ready') {
        console.log('[Receiver] Storage ready. Signaling sender to start.');
        if (this.peer && !this.peer.destroyed) {
          const msg = JSON.stringify({ type: 'TRANSFER_READY' });
          console.log('[Receiver] Sending TRANSFER_READY signal to sender');
          this.peer.send(msg);
        } else {
          console.error('[Receiver] Cannot send TRANSFER_READY - peer not available');
        }
      }
    };

    this.emit('status', 'CONNECTING');
    console.log('[Receiver] Initialization complete, waiting for peer connection');
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

    // 데이터 채널 설정을 통합
    const setupDataChannel = () => {
      // @ts-ignore
      if (peer._channel) {
        // @ts-ignore
        peer._channel.binaryType = 'arraybuffer';
        console.log('[WebRTC] Data channel setup complete, binaryType:', peer._channel.binaryType, 'state:', peer._channel.readyState);
      }
    };

    if (initiator) {
      console.log('[WebRTC] Initiator peer created');
    } else {
      console.log('[WebRTC] Receiver peer created');
    }

    peer.on('signal', data => {
      if (data.type === 'offer') signalingService.sendOffer(this.roomId!, data);
      else if (data.type === 'answer') signalingService.sendAnswer(this.roomId!, data);
      else if (data.candidate) signalingService.sendCandidate(this.roomId!, data);
    });

    peer.on('connect', () => {
      console.log('[WebRTC] Peer connected, setting up data channel');
      // 양쪽 모두 데이터 채널 설정
      setupDataChannel();
      
      // 데이터 채널이 완전히 열릴 때까지 잠시 대기 후 설정 확인
      setTimeout(() => {
        console.log('[WebRTC] Data channel state after delay:', peer._channel?.readyState);
        console.log('[WebRTC] Data channel binaryType after delay:', peer._channel?.binaryType);
      }, 100);
      
      this.emit('connected', true);
      if (initiator) {
        // 송신자는 데이터 채널 설정 후 약간의 지연을 두고 전송 시작
        setTimeout(() => {
          this.startTransferSequence();
        }, 200);
      }
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
      
      console.log('[WebRTC] Data received:', {
        type: dataType,
        size: dataSize,
        isString: typeof data === 'string',
        firstBytes: data instanceof Uint8Array ? Array.from(data.slice(0, 4)) : 'N/A',
        isSender: this.isSender
      });

      // 1. JSON 메시지 처리 (Manifest, ACK, DOWNLOAD_COMPLETE, TRANSFER_READY)
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
            // 🚨 [핵심] 수신자의 완료 신호를 받았을 때만 complete 이벤트 발생
            if (this.awaitingReceiverComplete) {
              console.log('[Sender] Received DOWNLOAD_COMPLETE from receiver, emitting complete event');
              this.awaitingReceiverComplete = false;
              this.emit('complete', true);
            }
            return;
          }
          // 🚨 [추가] 수신자가 준비되었다는 신호를 보내면 전송 시작
          if (msg.type === 'TRANSFER_READY') {
            console.log('[Sender] Receiver is ready! Starting transfer.');
            this.isTransferring = true;
            this.emit('status', 'TRANSFERRING');
            if (this.worker) {
              console.log('[Sender] Sending start message to worker');
              this.worker.postMessage({ type: 'start' }); // 워커 가동
            } else {
              console.error('[Sender] Worker not available to start transfer');
            }
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
        // 🚨 [수정] JSON 파싱 시도 조건 강화
        // 파일 청크는 헤더(18바이트) + 데이터이므로 보통 큽니다.
        // 시그널링 JSON 메시지는 보통 작습니다 (1KB 미만).
        // 따라서 1KB 미만이고 시작 문자가 '{'일 때만 파싱을 시도하여 오동작 방지
        const isPotentialJson = (firstByte === 123 || firstByte === 91) && data.byteLength < 1024;
        
        if (isPotentialJson) { // '{' or '[' and small size
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
              // 🚨 [핵심] 수신자의 완료 신호를 받았을 때만 complete 이벤트 발생
              if (this.awaitingReceiverComplete) {
                console.log('[Sender] Received DOWNLOAD_COMPLETE from receiver, emitting complete event');
                this.awaitingReceiverComplete = false;
                this.emit('complete', true);
              }
              return;
            }
            // 🚨 [추가] 수신자가 준비되었다는 신호를 보내면 전송 시작
            if (msg.type === 'TRANSFER_READY') {
              console.log('[Sender] Receiver is ready! Starting transfer.');
              this.isTransferring = true;
              this.emit('status', 'TRANSFERRING');
              if (this.worker) {
                console.log('[Sender] Sending start message to worker');
                this.worker.postMessage({ type: 'start' }); // 워커 가동
              } else {
                console.error('[Sender] Worker not available to start transfer');
              }
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
    this.awaitingReceiverComplete = false; // 🚨 [추가] 플래그 리셋
  }
}

export const transferService = new EnhancedWebRTCService();
