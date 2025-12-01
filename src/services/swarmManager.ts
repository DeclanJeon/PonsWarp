import { NativePeerConnection } from './nativePeerConnection';
import { IPeerConnection, IPeerState } from './peerConnectionTypes';
import { signalingService } from './signaling';
import { getSenderWorkerV1 } from './workerFactory';
import { TransferManifest } from '../types/types';
import { logInfo, logError } from '../utils/logger';
import {
  HIGH_WATER_MARK,
  HEADER_SIZE,
  BATCH_SIZE_INITIAL
} from '../utils/constants';
import { PeerConfig } from '../utils/config';

// 핵심 안전 상수: 절대 변경 금지
export const MAX_DIRECT_PEERS = 3;
const CONNECTION_TIMEOUT = 30000; // 30초
const READY_WAIT_TIME_1N = 10000; // 1:N 상황에서 대기 시간 (10초)

export interface SwarmState {
  roomId: string | null;
  peerCount: number;
  connectedCount: number;
  readyCount: number;
  isTransferring: boolean;
  highestBufferedAmount: number;
}

export interface BroadcastResult {
  successCount: number;
  failedPeers: string[];
}

export interface SwarmProgress {
  totalBytesSent: number;
  totalBytes: number;
  overallProgress: number;
  speed: number;
  peers: IPeerState[];
}

type EventHandler = (data: any) => void;

export class SwarmManager {
  private peers: Map<string, IPeerConnection> = new Map();
  private roomId: string | null = null;
  private worker: Worker | null = null;
  private isTransferring: boolean = false;
  private pendingManifest: TransferManifest | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};
  private activeRoomUsers: Set<string> = new Set(); // 🚀 [추가] 서버 기준 실제 방 유저 목록

  public on(event: string, handler: EventHandler): void {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(handler);
  }

  public off(event: string, handler: EventHandler): void {
    if (!this.eventListeners[event]) return;
    this.eventListeners[event] = this.eventListeners[event].filter(h => h !== handler);
  }

  private emit(event: string, data?: any): void {
    this.eventListeners[event]?.forEach(h => h(data));
  }

  public removeAllListeners(): void {
    this.eventListeners = {};
  }
  
  // Backpressure 제어
  private isProcessingBatch = false;
  private currentBatchSize = BATCH_SIZE_INITIAL;
  
  // 연결 타임아웃 관리
  private connectionTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  
  // 🚨 [FIX] 버퍼 모니터링 타이머 (drain 이벤트가 안 오는 경우 대비)
  private bufferMonitorInterval: ReturnType<typeof setInterval> | null = null;
  
  // ICE 서버 설정
  private iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  // 진행률 추적
  private totalBytesSent = 0;
  private totalBytes = 0;
  private transferStartTime = 0;
  
  // Keep-alive 타이머
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  // 🚀 [대기열 시스템]
  private transferQueue: string[] = []; // ready 대기열
  private completedPeersInSession: Set<string> = new Set(); // 현재 세션에서 완료된 피어
  private currentTransferPeers: Set<string> = new Set(); // 현재 전송 중인 피어들
  private readyPeersInSession: Set<string> = new Set(); // 🚀 [추가] 현재 세션에서 준비된 피어들 (10초 대기 중 누적)
  private files: File[] = []; // 전송할 파일 저장

  constructor() {
    this.setupSignalingHandlers();
  }

  private setupSignalingHandlers(): void {
    signalingService.on('peer-joined', this.handlePeerJoined.bind(this));
    signalingService.on('room-users', this.handleRoomUsers.bind(this)); // 🚀 [추가] 이벤트 연결
    signalingService.on('offer', this.handleOffer.bind(this));
    signalingService.on('answer', this.handleAnswer.bind(this));
    signalingService.on('ice-candidate', this.handleIceCandidate.bind(this));
    signalingService.on('user-left', this.handleUserLeft.bind(this));
    signalingService.on('room-full', () => {
      this.emit('room-full', 'Room is at maximum capacity');
    });
  }

  // ======================= 피어 관리 =======================

  /**
   * 새 피어 추가 (슬롯 제한 적용)
   */
  public addPeer(peerId: string, initiator: boolean): IPeerConnection | null {
    console.log(`[SwarmManager] ➕ addPeer called: ${peerId}, initiator: ${initiator}`);
    
    // 🚀 [패치] 슬롯이 꽉 찼을 때 좀비 피어 정리 로직 추가
    if (this.peers.size >= MAX_DIRECT_PEERS) {
      console.log('[SwarmManager] 🧹 Slot full. Cleaning up disconnected or dead peers...');
      
      // 1. 연결이 끊겼거나 닫힌 피어 우선 삭제
      for (const [pid, peer] of this.peers) {
        const pState = (peer as any).pc?.connectionState;
        const iState = (peer as any).pc?.iceConnectionState;
        if (!peer.connected || pState === 'disconnected' || pState === 'failed' || iState === 'disconnected') {
          console.log(`[SwarmManager] ⚰️ Removing dead peer: ${pid}`);
          this.removePeer(pid, 'force-cleanup');
        }
      }

      // 2. 여전히 꽉 찼다면, 가장 오래된 피어 제거 (FIFO) - 선택 사항
      if (this.peers.size >= MAX_DIRECT_PEERS) {
        const oldestPeerId = this.peers.keys().next().value;
        console.warn(`[SwarmManager] ⚠️ Still full. Kicking oldest peer: ${oldestPeerId}`);
        this.removePeer(oldestPeerId!, 'slot-limit-kick');
      }
    }

    // 이미 존재하는 피어 확인
    if (this.peers.has(peerId)) {
      logInfo('[SwarmManager]', `Peer already exists: ${peerId}`);
      return this.peers.get(peerId)!;
    }

    // 🚀 [Phase 2] NativePeerConnection 사용 (멀티 채널 지원)
    const nativeConfig: PeerConfig = {
      iceServers: this.iceServers,
      isInitiator: initiator,
      id: peerId
    };
    
    console.log(`[SwarmManager] 🔧 Creating NativePeerConnection for ${peerId}...`);
    const peer = new NativePeerConnection(nativeConfig);
    this.setupPeerEventHandlers(peer);
    this.peers.set(peerId, peer);
    this.setupConnectionTimeout(peerId);

    console.log(`[SwarmManager] ✅ Peer added: ${peerId} (${this.peers.size}/${MAX_DIRECT_PEERS})`);
    logInfo('[SwarmManager]', `Peer added: ${peerId} (${this.peers.size}/${MAX_DIRECT_PEERS})`);
    return peer;
  }

  /**
   * 🚀 [설계 10] 피어 제거
   * 
   * === 설계 문서 기반 ===
   * 10. Receiver가 방을 나가면 Sender의 카운트에서 제거, Receiver 정보 삭제
   * 27. 전송 완료 시 Receiver 정보 삭제, 카운트 제거
   */
  public removePeer(peerId: string, reason: string = 'unknown'): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    this.clearConnectionTimeout(peerId);
    peer.destroy();
    this.peers.delete(peerId);

    // 🚀 [설계 10] 모든 관련 상태에서 피어 정보 삭제
    this.currentTransferPeers.delete(peerId);
    this.completedPeersInSession.delete(peerId);
    const queueIndex = this.transferQueue.indexOf(peerId);
    if (queueIndex > -1) {
      this.transferQueue.splice(queueIndex, 1);
      logInfo('[SwarmManager]', `[설계 10] Peer ${peerId} removed from queue`);
    }

    logInfo('[SwarmManager]', `[설계 10] Peer removed: ${peerId} (reason: ${reason}), remaining peers: ${this.peers.size}`);
    this.emit('peer-disconnected', { peerId, reason });

    // 전송 중인 피어가 나갔다면 완료 체크
    if (this.isTransferring && this.currentTransferPeers.size === 0) {
      logInfo('[SwarmManager]', 'All transfer peers disconnected. Checking completion...');
      this.checkTransferComplete();
    }

    // 모든 피어가 연결 해제되면 전송 실패
    if (this.isTransferring && this.peers.size === 0) {
      this.emit('transfer-failed', 'All peers disconnected');
      this.cleanup();
    }
  }

  /**
   * 피어 조회
   */
  public getPeer(peerId: string): IPeerConnection | undefined {
    return this.peers.get(peerId);
  }

  /**
   * 피어 수 조회
   */
  public getPeerCount(): number {
    return this.peers.size;
  }

  /**
   * 연결된 피어 목록 조회
   */
  public getConnectedPeers(): IPeerConnection[] {
    return Array.from(this.peers.values()).filter(p => p.connected);
  }

  /**
   * Ready 상태인 피어 수 조회
   */
  public getReadyPeerCount(): number {
    return Array.from(this.peers.values()).filter(p => p.ready).length;
  }

  private setupPeerEventHandlers(peer: IPeerConnection): void {
    console.log(`[SwarmManager] 🔧 Setting up event handlers for peer: ${peer.id}`);
    
    peer.on('signal', (data) => {
      this.forwardSignal(peer.id, data);
    });

    peer.on('connected', (peerId) => {
      this.clearConnectionTimeout(peerId);
      logInfo('[SwarmManager]', `Peer connected: ${peerId}`);
      console.log(`[SwarmManager] 🔗 Peer ${peerId} connected! Total peers: ${this.peers.size}`);
      this.emit('peer-connected', peerId);
      
      // 🚀 [패치] 연결 즉시 Manifest 전송 (매우 중요)
      // Receiver가 새로고침 후 들어왔을 때, Manifest가 있어야 함
      setTimeout(() => {
        if (this.pendingManifest && peer.connected) {
          console.log(`[SwarmManager] 📤 Sending MANIFEST to peer: ${peerId}`);
          
          // Manifest 전송
          peer.send(JSON.stringify({
            type: 'MANIFEST',
            manifest: this.pendingManifest
          }));

          // 이미 전송 중이었다면, 현재 진행 상황도 알려줌 (선택)
          if (this.isTransferring) {
             peer.send(JSON.stringify({ type: 'TRANSFER_STARTED' }));
          }
        }
      }, 500); // 안정성을 위해 0.5초 딜레이
      
      // Keep-alive 시작
      this.startKeepAlive();
    });

    peer.on('data', (data) => {
      console.log(`[SwarmManager] 📥 'data' event received from peer ${peer.id}`);
      this.handlePeerData(peer.id, data);
    });

    peer.on('drain', (peerId) => {
      this.handleDrain(peerId);
    });

    peer.on('error', (error) => {
      logError('[SwarmManager]', `Peer error (${peer.id}):`, error);
      this.removePeer(peer.id, 'error');
    });

    peer.on('close', () => {
      this.removePeer(peer.id, 'closed');
    });
  }

  private setupConnectionTimeout(peerId: string): void {
    const timeout = setTimeout(() => {
      const peer = this.peers.get(peerId);
      if (peer && !peer.connected) {
        logError('[SwarmManager]', `Connection timeout: ${peerId}`);
        this.emit('peer-timeout', peerId);
        this.removePeer(peerId, 'timeout');
      }
    }, CONNECTION_TIMEOUT);

    this.connectionTimeouts.set(peerId, timeout);
  }

  private clearConnectionTimeout(peerId: string): void {
    const timeout = this.connectionTimeouts.get(peerId);
    if (timeout) {
      clearTimeout(timeout);
      this.connectionTimeouts.delete(peerId);
    }
  }

  // ======================= 시그널링 =======================

  // 🚀 [신규] 방 유저 목록 동기화 핸들러 (좀비 피어 즉시 사살)
  private handleRoomUsers(users: string[]): void {
    this.activeRoomUsers = new Set(users);
    const myId = signalingService.getSocketId();
    
    // 🚀 [핵심] 나를 제외한 방 유저 수 계산
    const otherUsersCount = users.filter(id => id !== myId).length;

    console.log('[SwarmManager] 🏠 Room users updated:', {
      totalUsers: users.length,
      otherUsersCount: otherUsersCount,
      users: users,
      myId: myId,
      currentPeers: Array.from(this.peers.keys())
    });

    // 내 피어 목록에는 있는데, 서버 목록(users)에는 없는 피어 -> 좀비임. 즉시 제거.
    for (const peerId of this.peers.keys()) {
      if (!this.activeRoomUsers.has(peerId) && peerId !== myId) {
        console.warn(`[SwarmManager] ⚰️ Found zombie peer (not in room): ${peerId}. Force removing.`);
        this.removePeer(peerId, 'zombie-cleanup');
      }
    }
    
    // 🚀 [추가] UI 업데이트를 위한 이벤트 발생
    this.emit('room-users-updated', {
      totalUsers: users.length,
      connectedPeers: this.peers.size
    });
  }

  private handlePeerJoined(data: any): void {
    console.log('[SwarmManager] 👋 handlePeerJoined called:', data);
    
    // 1. 기본 검증
    if (!this.roomId) {
      console.log('[SwarmManager] ⚠️ handlePeerJoined: No roomId set, ignoring');
      return;
    }
    const peerId = data?.socketId || data?.from;
    const myId = signalingService.getSocketId();
    
    console.log('[SwarmManager] 👋 Peer joined details:', {
      peerId,
      myId,
      roomId: this.roomId,
      currentPeers: [...this.peers.keys()]
    });
    
    // 자기 자신이거나 유효하지 않은 ID면 무시
    if (!peerId || peerId === myId) {
      console.log('[SwarmManager] ⚠️ handlePeerJoined: Ignoring self or invalid ID');
      return;
    }

    logInfo('[SwarmManager]', `👋 Peer joined signal: ${peerId}`);

    // 2. [핵심 수정] 이미 연결된 피어인지 확인
    const existingPeer = this.peers.get(peerId);
    
    if (existingPeer) {
        if (existingPeer.connected) {
            // 이미 연결 상태가 양호하다면, 중복 접속 신호는 무시
            logInfo('[SwarmManager]', `Peer ${peerId} is already connected. Ignoring join signal.`);
            return;
        } else {
            // 연결이 끊겼거나 불안정한 상태라면 제거 후 재연결 시도
            logInfo('[SwarmManager]', `Peer ${peerId} exists but not connected. Re-initializing...`);
            this.removePeer(peerId, 'rejoining');
        }
    }

    // 3. [1:N 지원] 슬롯 여유 확인
    if (this.peers.size >= MAX_DIRECT_PEERS) {
        console.warn(`[SwarmManager] ⚠️ Slot full (${this.peers.size}/${MAX_DIRECT_PEERS}). Cannot accept ${peerId}.`);
        
        // (선택) 연결이 끊긴 좀비 피어가 자리를 차지하고 있다면 정리
        for (const [pid, p] of this.peers) {
            if (!p.connected) {
                this.removePeer(pid, 'cleanup-dead-slot');
                break; // 한 명 정리되면 탈출 (새 피어 입장 가능)
            }
        }
        
        // 여전히 꽉 찼으면 리턴
        if (this.peers.size >= MAX_DIRECT_PEERS) return;
    }

    // 4. 피어 추가 (Sender로서 Initiator = true)
    // 약간의 딜레이를 주어 시그널링 충돌 방지
    setTimeout(() => {
        // 중복 체크 한 번 더 (비동기 딜레이 동안 상황이 변했을 수 있음)
        if (!this.peers.has(peerId)) {
            this.addPeer(peerId, true);
        }
    }, 100);
  }

  private handleOffer(data: any): void {
    // roomId가 설정되지 않았으면 무시
    if (!this.roomId) return;
    
    const peerId = data.from;
    if (!peerId) return;

    let peer = this.peers.get(peerId);
    if (!peer) {
      // 새 피어 생성 (Receiver로서, initiator = false)
      peer = this.addPeer(peerId, false);
      if (!peer) return; // 슬롯 제한으로 거부됨
    }

    peer.signal(data.offer);
  }

  private handleAnswer(data: any): void {
    // roomId가 설정되지 않았으면 무시
    if (!this.roomId) return;
    
    const peerId = data.from;
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.signal(data.answer);
    }
  }

  private handleIceCandidate(data: any): void {
    // roomId가 설정되지 않았으면 무시
    if (!this.roomId) return;
    
    const peerId = data.from;
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.signal(data.candidate);
    }
  }

  private handleUserLeft(data: any): void {
    // roomId가 설정되지 않았으면 무시
    if (!this.roomId) return;
    
    const peerId = data?.socketId;
    if (peerId) {
      this.removePeer(peerId, 'user-left');
    }
  }

  /**
   * 🚀 [Multi-Receiver] 시그널링 메시지를 특정 피어에게 전달
   * peerId를 target으로 지정하여 해당 피어에게만 메시지 전송
   */
  private forwardSignal(peerId: string, data: any): void {
    if (!this.roomId) return;

    // 🚀 [핵심] peerId를 target으로 지정하여 특정 피어에게만 전달
    if (data.type === 'offer') {
      signalingService.sendOffer(this.roomId, data.offer, peerId); // 🚨 [수정] offer 객체만 전달
    } else if (data.type === 'answer') {
      signalingService.sendAnswer(this.roomId, data.answer, peerId); // 🚨 [수정] answer 객체만 전달
    } else if (data.candidate) {
      signalingService.sendCandidate(this.roomId, data, peerId);
    }
  }

  // ======================= 브로드캐스팅 =======================

  /**
   * 🚀 [대기열] 청크를 현재 전송 대상 피어에게만 전송
   */
  public broadcastChunk(chunk: ArrayBuffer): BroadcastResult {
    const failedPeers: string[] = [];
    let successCount = 0;

    // 현재 전송 대상 피어에게만 전송
    for (const peerId of this.currentTransferPeers) {
      const peer = this.peers.get(peerId);
      if (!peer || !peer.connected) {
        failedPeers.push(peerId);
        continue;
      }
      
      try {
        peer.send(chunk);
        successCount++;
      } catch (error) {
        logError('[SwarmManager]', `Failed to send to peer ${peerId}:`, error);
        failedPeers.push(peerId);
      }
    }

    return { successCount, failedPeers };
  }

  /**
   * JSON 메시지를 모든 연결된 피어에게 브로드캐스트
   */
  public broadcastMessage(message: object): void {
    const jsonStr = JSON.stringify(message);
    const connectedPeers = this.getConnectedPeers();

    for (const peer of connectedPeers) {
      try {
        peer.send(jsonStr);
      } catch (error) {
        logError('[SwarmManager]', `Failed to send message to peer ${peer.id}:`, error);
      }
    }
  }

  private sendManifestToPeer(peer: IPeerConnection): void {
    if (!this.pendingManifest) return;
    
    try {
      peer.send(JSON.stringify({ type: 'MANIFEST', manifest: this.pendingManifest }));
      logInfo('[SwarmManager]', `Manifest sent to peer: ${peer.id}`);
    } catch (error) {
      logError('[SwarmManager]', `Failed to send manifest to peer ${peer.id}:`, error);
    }
  }

  // ======================= Backpressure =======================

  /**
   * 모든 피어 중 가장 높은 버퍼 크기 반환
   */
  public getHighestBufferedAmount(): number {
    let highest = 0;
    for (const peer of this.peers.values()) {
      if (peer.connected) {
        const buffered = peer.getBufferedAmount();
        if (buffered > highest) {
          highest = buffered;
        }
      }
    }
    return highest;
  }

  /**
   * 추가 청크 요청 가능 여부
   */
  public canRequestMoreChunks(): boolean {
    return this.getHighestBufferedAmount() < HIGH_WATER_MARK;
  }

  private handleDrain(peerId: string): void {
    
    // 글로벌 backpressure 재평가
    if (this.isTransferring && this.canRequestMoreChunks()) {
      this.requestMoreChunks();
    } else {
    }
  }

  // ======================= 데이터 처리 =======================

  private handlePeerData(peerId: string, data: ArrayBuffer | string): void {
    // 🚀 [디버그] 모든 데이터 수신 로깅
    console.log(`[SwarmManager] 📥 Data received from ${peerId}:`, {
      dataType: typeof data,
      isArrayBuffer: data instanceof ArrayBuffer,
      size: typeof data === 'string' ? data.length : (data as ArrayBuffer).byteLength,
      preview: typeof data === 'string' ? data.substring(0, 100) : 'binary'
    });
    
    // JSON 메시지 처리
    if (typeof data === 'string' || (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 123)) {
      try {
        const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
        const msg = JSON.parse(str);
        console.log(`[SwarmManager] ✅ Parsed JSON message from ${peerId}:`, msg.type);
        this.handleControlMessage(peerId, msg);
      } catch (e) {
        console.warn(`[SwarmManager] ⚠️ JSON parse failed for data from ${peerId}:`, e);
      }
      return;
    }

    // 바이너리 데이터는 Receiver 측에서 처리 (SwarmManager는 Sender 전용)
    this.emit('data', { peerId, data });
  }

  /**
   * 🚀 [핵심] 피어로부터 받은 제어 메시지 처리
   */
  private handleControlMessage(peerId: string, msg: any): void {
    const peer = this.peers.get(peerId);
    
    // 🚀 [디버그] 모든 제어 메시지 로깅
    console.log(`[SwarmManager] 📨 Control message from ${peerId}:`, msg.type, {
      peerExists: !!peer,
      peerConnected: peer?.connected,
      peerReady: peer?.ready,
      isTransferring: this.isTransferring,
      currentTransferPeers: [...this.currentTransferPeers],
      completedPeers: [...this.completedPeersInSession]
    });

    switch (msg.type) {
      case 'KEEP_ALIVE':
        // Keep-alive 메시지는 무시 (연결 유지 목적)
        return;
        
      case 'TRANSFER_READY':
        // 🚀 [설계 13] Receiver의 다운로드 신호 수신
        console.log(`[SwarmManager] 🎯 [설계 13] TRANSFER_READY received from ${peerId}!`, {
          peerExists: !!peer,
          peerConnected: peer?.connected,
          isTransferring: this.isTransferring,
          completedPeers: [...this.completedPeersInSession],
          currentPeers: [...this.peers.keys()]
        });
        
        // 이미 완료된 피어는 무시
        if (this.completedPeersInSession.has(peerId)) {
            logInfo('[SwarmManager]', `Peer ${peerId} already completed. Ignoring READY.`);
            return;
        }

        if (peer) {
          // 🚀 [설계 14] Sender가 Receiver의 신호를 받음
          peer.ready = true;
          
          // 🚀 [추가] readyPeersInSession에 추가 (중복 방지)
          if (!this.readyPeersInSession.has(peerId)) {
            this.readyPeersInSession.add(peerId);
            console.log(`[SwarmManager] 🟢 [DEBUG] Added ${peerId} to readyPeersInSession. Total: ${this.readyPeersInSession.size}`);
          }
          
          logInfo('[SwarmManager]', `🟢 [설계 14] Peer ready signal received: ${peerId}`);
          console.log(`[SwarmManager] 🟢 Peer ${peerId} marked as READY`);
          this.emit('peer-ready', peerId);

          // 🚀 [설계 24] 전송 중 새 피어가 ready하면 대기열에 추가
          if (this.isTransferring) {
            logInfo('[SwarmManager]', `⏸️ [설계 24] Transfer in progress. Adding ${peerId} to queue.`);
            console.log(`[SwarmManager] ⏸️ Adding ${peerId} to queue (transfer in progress)`);
            
            // 대기열 중복 방지
            if (!this.transferQueue.includes(peerId)) {
              this.transferQueue.push(peerId);
            }

            // 🚀 [설계 24] 대기 신호 전송 → Receiver가 대기 UI 렌더링
            try {
              peer.send(JSON.stringify({
                  type: 'QUEUED',
                  message: 'Transfer in progress. You are in the queue.',
                  position: this.transferQueue.length
              }));
            } catch (e) { /* ignore */ }
            
            // 🚀 [설계 25] Sender는 다음 순서가 이 피어라는 것을 기억
            this.emit('peer-queued', { peerId, position: this.transferQueue.length });
            return;
          }

          // 🚀 [설계 15-16] 전송 중이 아니면 피어 수 체크 후 전송 결정
          logInfo('[SwarmManager]', `✅ Not transferring. Checking peer count...`);
          console.log(`[SwarmManager] ✅ Calling checkAllPeersReady()...`);
          this.checkAllPeersReady();
        } else {
          logInfo('[SwarmManager]', `❌ Peer ${peerId} not found!`);
          console.error(`[SwarmManager] ❌ CRITICAL: Peer ${peerId} not found!`, {
            availablePeers: [...this.peers.keys()]
          });
        }
        break;
        

      case 'DOWNLOAD_COMPLETE':
        
        // 🚀 [핵심 수정] 중복 메시지라도 checkTransferComplete를 강제 실행
        // 이유: 첫 메시지 처리 시 타이밍 이슈로 완료 처리가 안 되었을 수 있음
        // 재전송 메커니즘(3회)이 있으므로 후속 메시지가 상태를 정상화할 기회를 줘야 함
        if (this.completedPeersInSession.has(peerId)) {
          // return 제거: 강제로 checkTransferComplete 실행
          this.checkTransferComplete();
          return;
        }
        
        
        logInfo('[SwarmManager]', `Peer completed download: ${peerId}`);
        this.completedPeerCount++;
        this.completedPeersInSession.add(peerId);
        this.currentTransferPeers.delete(peerId);
        
        // 🚀 [핵심] 완료된 피어의 ready 상태 리셋 (재다운로드 방지)
        if (peer) {
          peer.ready = false;
        }
        
        // 🚀 [추가] 완료된 피어를 readyPeersInSession에서도 제거
        this.readyPeersInSession.delete(peerId);
        
        
        this.emit('peer-complete', peerId);
        this.checkTransferComplete();
        break;

      default:
        this.emit('message', { peerId, message: msg });
    }
  }

  // 🚀 [Multi-Receiver] Ready 타이머 관련
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;
  private completedPeerCount = 0;

  /**
   * 🚀 [핵심 로직] 피어 Ready 상태 체크 및 전송 시작 결정
   * 
   * === 설계 문서 기반 로직 ===
   * 14-16. Sender가 신호 수신, 피어가 1명이면 즉시 전송 (1:1)
   * 17. 피어가 2명 이상이면 10초 카운트다운 시작
   * 22. 10초 내 모든 피어 ready → 동시 전송
   * 23. 10초 후 일부만 ready → ready된 피어에게만 전송
   * 
   * 🚨 [핵심] 1:N 판단 기준:
   * - activeRoomUsers (시그널링 서버 기준) 우선 사용
   * - 방에 접속한 피어 수를 정확히 카운팅
   * 
   * 🚀 [수정] 시그널링 서버에서 room-users 이벤트가 오기 전까지는
   * 연결된 피어 수(peers.size)를 기준으로 판단하되,
   * 이는 "최소한의 피어 수"로 간주함
   */
  private checkAllPeersReady(): void {
    const myId = signalingService.getSocketId();
    
    // 🚀 [설계 14-15] 방에 있는 총 유저 수 계산 (나 자신 제외)
    // 🚀 [수정] activeRoomUsers가 비어있으면 peers.size 사용 (fallback)
    // 단, peers.size는 WebRTC 연결된 수이므로 실제 방 유저 수보다 적을 수 있음
    const hasActiveRoomUsers = this.activeRoomUsers.size > 0;
    const roomUserCount = hasActiveRoomUsers
      ? Array.from(this.activeRoomUsers).filter(id => id !== myId).length
      : this.peers.size; // fallback: 연결된 피어 수 (최소 기준)
    
    console.log('[SwarmManager] 🔍 checkAllPeersReady() called', {
      isTransferring: this.isTransferring,
      peersCount: this.peers.size,
      activeRoomUsers: this.activeRoomUsers.size,
      hasActiveRoomUsers: hasActiveRoomUsers,
      roomUserCount: roomUserCount,
      readyTimeout: !!this.readyTimeout
    });
    
    if (this.isTransferring) {
      logInfo('[SwarmManager]', `⏸️ Already transferring. Skipping checkAllPeersReady.`);
      return;
    }

    const connectedPeers = this.getConnectedPeers();
    
    // 🚀 [설계 15] 방에 접속한 피어 중 아직 완료하지 않은 피어 수
    const totalPendingCount = roomUserCount - this.completedPeersInSession.size;
    
    // 🚀 [수정] readyPeersInSession을 기준으로 준비된 피어 수 계산
    // 이렇게 해야 1:N 상황에서 정확하게 카운트됨
    const readyCount = this.readyPeersInSession.size;
    
    // 🚀 [디버그] 기존 방식과 새 방식 비교
    const oldReadyPeers = connectedPeers.filter(p => p.ready && !this.completedPeersInSession.has(p.id));
    
    console.log('[SwarmManager] 📊 [DEBUG] CheckReady Status:', {
      roomUserCount: roomUserCount,
      totalPendingCount: totalPendingCount,
      connectedPeers: connectedPeers.length,
      // 기존 방식
      oldReadyCount: oldReadyPeers.length,
      oldReadyIds: oldReadyPeers.map(p => p.id),
      // 새 방식
      newReadyCount: readyCount,
      newReadyIds: [...this.readyPeersInSession],
      hasActiveRoomUsers: hasActiveRoomUsers,
      activeRoomUsers: [...this.activeRoomUsers],
      connectedIds: connectedPeers.map(p => p.id),
      completedPeers: [...this.completedPeersInSession]
    });
    logInfo('[SwarmManager]', `📊 [DEBUG] CheckReady: RoomUsers=${roomUserCount}, Pending=${totalPendingCount}, Connected=${connectedPeers.length}, OldReady=${oldReadyPeers.length}, NewReady=${readyCount}`);

    if (readyCount === 0) {
      logInfo('[SwarmManager]', `⚠️ No ready peers. Waiting for TRANSFER_READY...`);
      return;
    }

    // ---------------------------------------------------------
    // 🚀 [수정] room-users 이벤트가 아직 안 왔으면 잠시 대기 후 재시도
    // 네트워크 지연으로 인한 1:1 오판 방지
    // ---------------------------------------------------------
    if (!hasActiveRoomUsers && !this.readyTimeout) {
      logInfo('[SwarmManager]', `⏳ No room-users data yet. Waiting 1s for server sync...`);
      console.log('[SwarmManager] ⏳ Waiting for room-users event before deciding...');
      
      // 1초 후 재시도 (room-users 이벤트 수신 대기)
      setTimeout(() => {
        // 이미 전송 중이거나 타임아웃이 설정되었으면 스킵
        if (this.isTransferring || this.readyTimeout) return;
        
        // room-users가 여전히 없으면 peers.size 기준으로 진행
        if (this.activeRoomUsers.size === 0) {
          logInfo('[SwarmManager]', `⚠️ room-users still empty. Proceeding with peers.size fallback.`);
        }
        this.checkAllPeersReady();
      }, 1000);
      return;
    }

    // ---------------------------------------------------------
    // [설계 16] 1:1 상황 -> 즉시 시작 (카운트다운 없음)
    // 조건: 방에 피어가 1명뿐이고, 그 피어가 ready 상태
    // ---------------------------------------------------------
    if (hasActiveRoomUsers && totalPendingCount === 1 && readyCount === 1) {
      logInfo('[SwarmManager]', `⚡ [설계 16] 1:1 situation - Starting immediately.`);
      console.log('[SwarmManager] ⚡ [DEBUG] CASE 1: 1:1 situation - Starting immediately!');
      this.clearReadyTimeout();
      this.emit('all-peers-ready');
      this.startTransferWithReadyPeers();
      return;
    }

    // ---------------------------------------------------------
    // [설계 22] 모든 대기자가 준비됨 -> 즉시 시작
    // 조건: 방에 2명 이상이고, 모두 ready 상태
    // ---------------------------------------------------------
    if (hasActiveRoomUsers && totalPendingCount > 1 && totalPendingCount === readyCount) {
      logInfo('[SwarmManager]', `⚡ [설계 22] All ${totalPendingCount} users ready - Starting immediately.`);
      console.log(`[SwarmManager] ⚡ [DEBUG] CASE 2: All ${totalPendingCount} users ready - Starting immediately!`);
      this.clearReadyTimeout();
      this.emit('all-peers-ready');
      this.startTransferWithReadyPeers();
      return;
    }

    // ---------------------------------------------------------
    // [설계 17] 1:N 상황 (일부만 준비됨) -> 10초 카운트다운 시작
    // 조건: 방에 2명 이상이고, 일부만 ready 상태
    // ---------------------------------------------------------
    if (!this.readyTimeout) {
      const reason = `Partial ready (${readyCount}/${totalPendingCount})`;
      
      logInfo('[SwarmManager]', `⏳ [설계 17] ${reason}. Starting 10s countdown...`);
      console.log(`[SwarmManager] ⏳ [DEBUG] CASE 3: Starting ${READY_WAIT_TIME_1N/1000}s countdown`, {
        reason: reason,
        readyPeers: readyCount,
        totalPendingCount: totalPendingCount,
        waitTime: READY_WAIT_TIME_1N
      });
      
      // UI에 카운트다운 표시
      this.emit('ready-countdown-start', {
        readyCount: readyCount,
        totalCount: totalPendingCount,
        waitTime: READY_WAIT_TIME_1N
      });

      // [설계 23] 10초 후 ready된 피어에게만 전송
      this.readyTimeout = setTimeout(() => {
        this.readyTimeout = null;
        logInfo('[SwarmManager]', '⏰ [설계 23] Timeout reached. Starting with ready peers only.');
        console.log('[SwarmManager] ⏰ Countdown timeout! Starting transfer with ready peers...');
        this.emit('all-peers-ready');
        this.startTransferWithReadyPeers();
      }, READY_WAIT_TIME_1N);
    }
    // 이미 카운트다운 중이면 인원수만 업데이트
    else {
       console.log(`[SwarmManager] ⏳ [DEBUG] Countdown running. Count: ${readyCount}/${totalPendingCount}`);
       this.emit('ready-countdown-update', {
        readyCount: readyCount,
        totalCount: totalPendingCount
      });
    }
  }

  private clearReadyTimeout(): void {
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
  }

  /**
   * 🚀 [Multi-Receiver] Ready된 피어만으로 전송 시작
   * Not-ready 피어는 연결 유지하되 전송에서 제외
   */
  private startTransferWithReadyPeers(): void {
    console.log('[SwarmManager] 🚀 startTransferWithReadyPeers() called');
    
    // 🚀 [수정] readyPeersInSession을 기준으로 전송 대상 결정
    const readyPeers = Array.from(this.readyPeersInSession)
      .map(id => this.peers.get(id))
      .filter((p): p is IPeerConnection => !!p && p.connected && !this.completedPeersInSession.has(p.id));
    
    console.log('[SwarmManager] 🚀 [DEBUG] Ready peers for transfer:', {
      connectedCount: this.getConnectedPeers().length,
      readySessionCount: this.readyPeersInSession.size,
      readyCount: readyPeers.length,
      readyPeerIds: readyPeers.map(p => p.id),
      readySessionIds: [...this.readyPeersInSession]
    });
    
    if (readyPeers.length === 0) {
      console.error('[SwarmManager] ❌ No ready peers! Transfer failed.');
      this.emit('transfer-failed', 'No receivers ready');
      return;
    }
    
    // 현재 전송 대상 확정
    this.currentTransferPeers = new Set(readyPeers.map(p => p.id));
    
    // 🚀 [중요] 전송 시작 후 readyPeersInSession 초기화
    this.readyPeersInSession.clear();
    
    logInfo('[SwarmManager]', `🚀 Launching transfer to ${readyPeers.length} peers.`);
    console.log(`[SwarmManager] 🚀 LAUNCHING TRANSFER to ${readyPeers.length} peers:`, [...this.currentTransferPeers]);
    this.emit('transfer-batch-start', { peerCount: readyPeers.length });
    
    // 각 피어에게 Manifest 및 시작 신호 전송
    for (const peer of readyPeers) {
      try {
        if (this.pendingManifest) {
          console.log(`[SwarmManager] 📤 Sending MANIFEST to ${peer.id}`);
          peer.send(JSON.stringify({ type: 'MANIFEST', manifest: this.pendingManifest }));
        }
        // ReceiverView가 이 신호를 받으면 RECEIVING 상태로 전환됨
        console.log(`[SwarmManager] 📤 Sending TRANSFER_STARTED to ${peer.id}`);
        peer.send(JSON.stringify({ type: 'TRANSFER_STARTED' }));
      } catch (e) { logError('[SwarmManager]', `Start signal failed for ${peer.id}`, e); }
    }
    
    console.log('[SwarmManager] 🚀 Calling startTransfer() to begin data transmission...');
    this.startTransfer(); // 실제 데이터 전송 (Worker) 시작
  }

  /**
   * 🚀 [설계 26-27] 전송 완료 체크 및 대기열 처리
   * 
   * === 설계 문서 기반 ===
   * 26. Sender는 Receiver A 전송 완료 후 Receiver B에게 즉시 전송
   * 27. Sender는 Receiver A 전송 완료 시 A의 정보 삭제, 카운트 제거
   */
  private checkTransferComplete(): void {
    // 아직 전송 중인 피어가 남아있다면 대기
    if (this.currentTransferPeers.size > 0) {
      logInfo('[SwarmManager]', `Still transferring to ${this.currentTransferPeers.size} peers. Waiting...`);
      return;
    }

    logInfo('[SwarmManager]', '[설계 27] Batch transfer finished.');
    this.isTransferring = false;
    
    // 버퍼 모니터링 중지
    this.stopBufferMonitoring();

    // 🚀 [설계 26] 대기열에 피어가 있으면 즉시 다음 전송 시작
    if (this.transferQueue.length > 0) {
      logInfo('[SwarmManager]', `🔄 [설계 26] Processing queue: ${this.transferQueue.length} peers waiting.`);
      
      this.emit('preparing-next-transfer', { queueSize: this.transferQueue.length });

      // 약간의 딜레이 후 대기열 처리 (UI 업데이트 시간 확보)
      setTimeout(() => this.processQueue(), 1000);
      return;
    }
    
    // 대기열도 비었고, 현재 배치도 끝남
    // "연결은 되어있는데 아직 MATERIALIZE 안 누른" 사람 확인
    const pendingPeers = this.getConnectedPeers().filter(p => !this.completedPeersInSession.has(p.id));
    
    logInfo('[SwarmManager]', `Transfer complete check: Pending=${pendingPeers.length}, Completed=${this.completedPeersInSession.size}`);
    
    if (pendingPeers.length === 0 && this.completedPeersInSession.size > 0) {
        // 🚀 모든 연결된 피어가 다 받음 -> 최종 완료
        logInfo('[SwarmManager]', '🎉 All transfers complete!');
        this.emit('all-transfers-complete');
    } else if (pendingPeers.length > 0) {
        // 아직 MATERIALIZE 안 누른 피어가 남아있음 -> 부분 완료 상태
        logInfo('[SwarmManager]', `Batch complete. ${pendingPeers.length} peers still waiting.`);
        this.emit('batch-complete', { 
          completedCount: this.completedPeersInSession.size,
          waitingCount: pendingPeers.length
        });
    }
  }

  /**
   * 🚀 [설계 26] 대기열 처리 - 다음 전송 시작
   * 
   * === 설계 문서 기반 ===
   * 26. Sender는 Receiver A 전송 완료 후 Receiver B에게 즉시 전송
   */
  private processQueue(): void {
    logInfo('[SwarmManager]', `[설계 26] Processing queue: ${this.transferQueue.length} peers`);
    
    const nextPeerIds = [...this.transferQueue];
    this.transferQueue = []; // 큐 비우기

    // 유효한 피어(연결됨 & 미완료)만 선별
    const validPeers: IPeerConnection[] = [];
    for (const peerId of nextPeerIds) {
      const peer = this.peers.get(peerId);
      if (peer && peer.connected && !this.completedPeersInSession.has(peerId)) {
        validPeers.push(peer);
        peer.ready = true; // 대기열에 있었으므로 준비된 것으로 간주
        
        // 🚀 [추가] readyPeersInSession에도 추가
        this.readyPeersInSession.add(peerId);
        
        logInfo('[SwarmManager]', `Valid queued peer: ${peerId}`);
      } else {
        // 🚀 [설계 10] 방을 나간 피어는 제외
        logInfo('[SwarmManager]', `Skipping invalid queued peer: ${peerId} (connected=${peer?.connected}, completed=${this.completedPeersInSession.has(peerId)})`);
      }
    }

    if (validPeers.length === 0) {
      logInfo('[SwarmManager]', 'No valid peers in queue. Checking transfer complete.');
      this.checkTransferComplete();
      return;
    }

    // 전송 대상 설정
    this.currentTransferPeers = new Set(validPeers.map(p => p.id));
    
    logInfo('[SwarmManager]', `[설계 26] Starting transfer to ${validPeers.length} queued peers`);
    
    // 대기열 피어들에게 "전송 시작" 알림 (QUEUED -> RECEIVING 전환)
    for (const peer of validPeers) {
      try {
        // Manifest 재전송
        if (this.pendingManifest) {
          peer.send(JSON.stringify({ type: 'MANIFEST', manifest: this.pendingManifest }));
          logInfo('[SwarmManager]', `Manifest sent to queued peer: ${peer.id}`);
        }
        // 🚀 TRANSFER_STARTING 신호 전송 (ReceiverView가 QUEUED -> RECEIVING 전환)
        peer.send(JSON.stringify({ type: 'TRANSFER_STARTING' }));
        logInfo('[SwarmManager]', `Transfer starting signal sent to: ${peer.id}`);
      } catch (e) {
        logError('[SwarmManager]', `Failed to send to queued peer ${peer.id}:`, e);
      }
    }

    this.emit('queue-cleared', { processedCount: validPeers.length });
    
    // 전송 시작
    this.startTransfer();
  }

  // ======================= 전송 제어 =======================

  /**
   * Sender 초기화
   */
  public async initSender(manifest: TransferManifest, files: File[], roomId: string, encryptionKeyStr?: string): Promise<void> {
    logInfo('[SwarmManager]', 'Initializing sender...');
    this.cleanup();
    
    this.roomId = roomId;
    this.pendingManifest = manifest;
    this.files = files; // 🚀 [대기열] 파일 저장 (재전송용)
    this.totalBytes = manifest.totalSize;
    this.totalBytesSent = 0;
    this.completedPeerCount = 0;

    // TURN 설정 가져오기
    await this.fetchTurnConfig(roomId);

    // 시그널링 연결
    await signalingService.connect();
    
    // 🚀 [수정] 명시적인 방 참여 보장 (이미 연결되어 있어도 다시 호출)
    await signalingService.joinRoom(roomId);

    // Worker 초기화
    this.worker = getSenderWorkerV1();
    this.setupWorkerHandlers(files, manifest, encryptionKeyStr);

    this.emit('status', 'WAITING_FOR_PEER');
  }

  private setupWorkerHandlers(files: File[], manifest: TransferManifest, encryptionKeyStr?: string): void {
    if (!this.worker) return;

    this.worker.onmessage = (e) => {
      const { type, payload } = e.data;

      switch (type) {
        case 'ready':
          // startTransfer에서 즉시 초기화하므로 여기서는 초기화하지 않음
          break;

        case 'init-complete':
          this.workerInitialized = true;
          
          // 🚀 [핵심 수정] 전송 대기 중이면 즉시 첫 배치 요청
          if (this.pendingTransferStart && this.isTransferring) {
            this.pendingTransferStart = false;
            this.requestMoreChunks();
          }
          break;

        case 'error':
          this.emit('error', payload.message || 'Worker error occurred');
          this.cleanup();
          break;

        case 'chunk-batch':
          this.handleBatchFromWorker(payload);
          break;

        case 'complete':
          this.finishTransfer();
          break;
          
        default:
      }
    };

    this.worker.onerror = (error) => {
      this.emit('error', 'Worker crashed: ' + (error.message || 'Unknown error'));
      this.cleanup();
    };
  }

  private handleBatchFromWorker(payload: any): void {
    const connectedPeers = this.getConnectedPeers();
    if (connectedPeers.length === 0) {
      this.isProcessingBatch = false; // 🚨 [FIX] 플래그 리셋
      return;
    }

    const { chunks, progressData } = payload;


    try {
      // 모든 피어에게 브로드캐스트
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        
        const result = this.broadcastChunk(chunk);
        this.totalBytesSent += chunk.byteLength;


        // 실패한 피어 제거
        for (const failedPeerId of result.failedPeers) {
          this.removePeer(failedPeerId, 'send-failed');
        }
      }

      // 🚨 [FIX] 배치 처리 완료 - 플래그를 여기서 리셋 (다음 요청 가능하도록)
      this.isProcessingBatch = false;

      // 진행률 방출
      this.emitProgress(progressData);

      // Backpressure 체크 후 다음 배치 요청
      const canRequestMore = this.canRequestMoreChunks();
      
      if (canRequestMore) {
        this.requestMoreChunks();
      } else {
      }
    } catch (error) {
      this.isProcessingBatch = false; // 🚨 [FIX] 에러 시에도 플래그 리셋
      this.cleanup();
    }
  }

  // Worker 초기화 완료 대기용 플래그
  private workerInitialized = false;
  private pendingTransferStart = false;

  private startTransfer(): void {
    if (this.isTransferring) return;

    this.isTransferring = true;
    this.isProcessingBatch = false;
    this.totalBytesSent = 0;
    this.transferStartTime = performance.now();
    this.workerInitialized = false;
    this.pendingTransferStart = true;
    
    // 🚀 [대기열] Worker 재초기화 (새 전송 시작)
    if (this.worker) {
      this.worker.terminate();
    }
    this.worker = getSenderWorkerV1();
    this.setupWorkerHandlers(this.files, this.pendingManifest!);
    
    // 🚀 [핵심] 현재 전송 대상 피어에게 Manifest 재전송 + 전송 시작 알림
    for (const peerId of this.currentTransferPeers) {
      const peer = this.peers.get(peerId);
      if (peer && peer.connected) {
        try {
          // 대기열에서 온 피어에게는 Manifest도 다시 전송 (이미 받았을 수 있지만 확실히)
          if (this.pendingManifest) {
            peer.send(JSON.stringify({ type: 'MANIFEST', manifest: this.pendingManifest }));
          }
          peer.send(JSON.stringify({ type: 'TRANSFER_STARTED' }));
        } catch (e) { /* ignore */ }
      }
    }
    
    // 진행률 초기화 이벤트 발생
    this.emit('progress', {
      progress: 0,
      totalBytesSent: 0,
      totalBytes: this.totalBytes,
      speed: 0,
      peers: this.getPeerStates()
    });
    
    this.emit('status', 'TRANSFERRING');
    
    // 🚨 [핵심 FIX] 버퍼 모니터링 시작 (drain 이벤트가 안 오는 경우 대비)
    this.startBufferMonitoring();
    
    // Worker 초기화 즉시 시작
    if (this.worker && this.files.length > 0 && this.pendingManifest) {
      this.worker.postMessage({
        type: 'init',
        payload: {
          files: this.files,
          manifest: this.pendingManifest
        }
      });
      this.workerInitialized = true;
      
      // 즉시 첫 배치 요청
      setTimeout(() => {
        if (this.isTransferring && this.workerInitialized) {
          this.pendingTransferStart = false;
          this.requestMoreChunks();
        }
      }, 100);
    }
  }

  private requestMoreChunks(): void {
    
    if (this.isProcessingBatch) {
      return;
    }
    
    if (!this.worker) {
      return;
    }
    
    if (!this.isTransferring) {
      return;
    }
    
    // 🚨 [FIX] Worker 초기화 완료 체크 (Race Condition 방지)
    if (!this.workerInitialized) {
      return;
    }

    this.isProcessingBatch = true;
    this.worker.postMessage({ type: 'process-batch', payload: { count: this.currentBatchSize } });
  }

  private async finishTransfer(): Promise<void> {
    this.isTransferring = false;

    // 버퍼가 비워질 때까지 대기
    await this.waitForBufferZero();
    await new Promise(resolve => setTimeout(resolve, 500));

    // EOS 패킷 브로드캐스트
    const eosPacket = new ArrayBuffer(HEADER_SIZE);
    const view = new DataView(eosPacket);
    view.setUint16(0, 0xFFFF, true);

    this.broadcastChunk(eosPacket);
    logInfo('[SwarmManager]', 'EOS broadcast complete');
    
    this.emit('remote-processing', true);
  }

  private waitForBufferZero(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.getHighestBufferedAmount() === 0) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  /**
   * 🚀 [핵심 요구사항] 진행률/속도가 실제 데이터 전송과 정확히 일치해야 함
   * 
   * - progress: 실제 전송된 바이트 / 전체 바이트 * 100
   * - speed: 실제 전송된 바이트 / 경과 시간
   * - bytesTransferred: 실제 전송된 바이트 (totalBytesSent)
   */
  private emitProgress(progressData: any): void {
    const elapsed = (performance.now() - this.transferStartTime) / 1000;
    
    // 🚀 [정확성] 실제 전송된 바이트 기반 속도 계산
    const speed = elapsed > 0 ? this.totalBytesSent / elapsed : 0;
    
    // 🚀 [정확성] 실제 전송된 바이트 기반 진행률 계산
    const progress = this.totalBytes > 0 
      ? (this.totalBytesSent / this.totalBytes) * 100 
      : 0;

    this.emit('progress', {
      ...progressData,
      progress: Math.min(progress, 100), // 100% 초과 방지
      totalBytesSent: this.totalBytesSent,
      bytesTransferred: this.totalBytesSent, // UI 호환성
      totalBytes: this.totalBytes,
      speed,
      peers: this.getPeerStates()
    });
  }

  // ======================= 상태 조회 =======================

  /**
   * Swarm 상태 조회
   */
  public getState(): SwarmState {
    return {
      roomId: this.roomId,
      peerCount: this.peers.size,
      connectedCount: this.getConnectedPeers().length,
      readyCount: this.getReadyPeerCount(),
      isTransferring: this.isTransferring,
      highestBufferedAmount: this.getHighestBufferedAmount()
    };
  }

  /**
   * 모든 피어 상태 조회
   */
  public getPeerStates(): IPeerState[] {
    return Array.from(this.peers.values()).map(p => p.getState());
  }

  // ======================= 유틸리티 =======================

  private async fetchTurnConfig(roomId: string): Promise<void> {
    try {
      const response = await signalingService.requestTurnConfig(roomId);
      if (response.success && response.data) {
        this.iceServers = response.data.iceServers;
      }
    } catch (error) {
      logError('[SwarmManager]', 'Failed to fetch TURN config:', error);
    }
  }

  /**
   * Keep-alive 시작 (연결 유지용)
   */
  private startKeepAlive(): void {
    if (this.keepAliveInterval) return;
    
    this.keepAliveInterval = setInterval(() => {
      const connectedPeers = this.getConnectedPeers();
      if (connectedPeers.length === 0) {
        this.stopKeepAlive();
        return;
      }
      
      // 전송 중이 아닐 때만 keep-alive 전송 (전송 중에는 데이터가 계속 흐름)
      if (!this.isTransferring) {
        for (const peer of connectedPeers) {
          try {
            peer.send(JSON.stringify({ type: 'KEEP_ALIVE' }));
          } catch (e) {
            // 전송 실패 시 무시
          }
        }
      }
    }, 5000); // 5초마다
    
    logInfo('[SwarmManager]', 'Keep-alive started');
  }
  
  /**
   * Keep-alive 중지
   */
  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      logInfo('[SwarmManager]', 'Keep-alive stopped');
    }
  }
  
  /**
   * 🚨 [FIX] 버퍼 모니터링 시작
   * drain 이벤트가 제대로 발생하지 않는 경우를 대비한 폴백 메커니즘
   */
  private startBufferMonitoring(): void {
    if (this.bufferMonitorInterval) return;
    
    this.bufferMonitorInterval = setInterval(() => {
      if (!this.isTransferring) {
        this.stopBufferMonitoring();
        return;
      }
      
      const highestBuffered = this.getHighestBufferedAmount();
      const canRequest = this.canRequestMoreChunks();
      
      // 버퍼가 충분히 비었는데 배치 처리 중이 아니고 전송 중이면 요청
      if (canRequest && !this.isProcessingBatch && this.isTransferring && this.workerInitialized) {
        this.requestMoreChunks();
      }
    }, 200); // 200ms마다 체크
    
    logInfo('[SwarmManager]', 'Buffer monitoring started');
  }
  
  /**
   * 버퍼 모니터링 중지
   */
  private stopBufferMonitoring(): void {
    if (this.bufferMonitorInterval) {
      clearInterval(this.bufferMonitorInterval);
      this.bufferMonitorInterval = null;
      logInfo('[SwarmManager]', 'Buffer monitoring stopped');
    }
  }
  
  /**
   * 리소스 정리
   */
  public cleanup(): void {
    logInfo('[SwarmManager]', 'Cleaning up...');

    this.isTransferring = false;
    this.isProcessingBatch = false;
    this.roomId = null; // roomId 초기화로 이벤트 처리 중단

    // Keep-alive 정리
    this.stopKeepAlive();
    
    // 버퍼 모니터링 정리
    this.stopBufferMonitoring();

    // Ready 타이머 정리
    this.clearReadyTimeout();

    // 모든 타임아웃 정리
    for (const timeout of this.connectionTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.connectionTimeouts.clear();

    // 모든 피어 정리
    for (const peer of this.peers.values()) {
      peer.destroy();
    }
    this.peers.clear();

    // Worker 정리
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.pendingManifest = null;
    this.totalBytesSent = 0;
    this.completedPeerCount = 0;
    
    // 대기열 시스템 초기화
    this.transferQueue = [];
    this.completedPeersInSession.clear();
    this.currentTransferPeers.clear();
    this.readyPeersInSession.clear(); // 🚀 [추가] readyPeersInSession 초기화
    this.files = [];
    
    // 🚀 [추가] 방 유저 목록 초기화
    this.activeRoomUsers.clear();
  }

  /**
   * 🚀 [대기열] 대기열 상태 조회
   */
  public getQueueState() {
    return {
      queueSize: this.transferQueue.length,
      currentTransferPeers: [...this.currentTransferPeers],
      completedPeers: [...this.completedPeersInSession],
      waitingPeers: this.getConnectedPeers()
        .filter(p => !p.ready && !this.completedPeersInSession.has(p.id))
        .map(p => p.id)
    };
  }
}

// 참고: 싱글톤 대신 SenderView에서 인스턴스를 직접 생성하여 사용
// 이렇게 하면 각 전송 세션이 독립적으로 관리됨
