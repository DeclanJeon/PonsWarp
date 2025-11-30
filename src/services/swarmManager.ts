/**
 * SwarmManager - 여러 피어 연결을 관리하는 오케스트레이터
 * 
 * 1:N 브로드캐스팅과 슬롯 관리를 담당.
 * 최대 3개의 직접 피어 연결을 관리 (Sender 보호).
 * 
 * 🚀 [핵심 로직]
 * - 1:1 상황: 피어가 ready되면 즉시 전송 시작
 * - 1:N 상황: 첫 피어 ready 후 10초 대기, 그 사이 ready된 피어 모두에게 동시 전송
 * - 전송 중 새 피어 ready: 대기열에 추가, 현재 전송 완료 후 자동 시작
 * - 모든 피어 완료: Transfer Success UI 표시
 */
import { SinglePeerConnection, PeerConfig } from './singlePeerConnection';
import { NativePeerConnection, NativePeerConfig } from './nativePeerConnection';
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

    const config: PeerConfig = {
      iceServers: this.iceServers
    };

    // 🚀 [Phase 2] NativePeerConnection 사용 (멀티 채널 지원)
    const nativeConfig: NativePeerConfig = {
      iceServers: this.iceServers,
      isInitiator: initiator,
      id: peerId
    };
    
    const peer = new NativePeerConnection(nativeConfig);
    this.setupPeerEventHandlers(peer);
    this.peers.set(peerId, peer);
    this.setupConnectionTimeout(peerId);

    logInfo('[SwarmManager]', `Peer added: ${peerId} (${this.peers.size}/${MAX_DIRECT_PEERS})`);
    return peer;
  }

  /**
   * 피어 제거
   */
  public removePeer(peerId: string, reason: string = 'unknown'): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    this.clearConnectionTimeout(peerId);
    peer.destroy();
    this.peers.delete(peerId);

    logInfo('[SwarmManager]', `Peer removed: ${peerId} (reason: ${reason})`);
    this.emit('peer-disconnected', { peerId, reason });

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
    peer.on('signal', (data) => {
      this.forwardSignal(peer.id, data);
    });

    peer.on('connected', (peerId) => {
      this.clearConnectionTimeout(peerId);
      logInfo('[SwarmManager]', `Peer connected: ${peerId}`);
      this.emit('peer-connected', peerId);
      
      // 🚀 [패치] 연결 즉시 Manifest 전송 (매우 중요)
      // Receiver가 새로고침 후 들어왔을 때, Manifest가 있어야 함
      setTimeout(() => {
        if (this.pendingManifest && peer.connected) {
          
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

    // 내 피어 목록에는 있는데, 서버 목록(users)에는 없는 피어 -> 좀비임. 즉시 제거.
    for (const peerId of this.peers.keys()) {
      if (!this.activeRoomUsers.has(peerId) && peerId !== myId) {
        console.warn(`[SwarmManager] ⚰️ Found zombie peer (not in room): ${peerId}. Force removing.`);
        this.removePeer(peerId, 'zombie-cleanup');
      }
    }
  }

  private handlePeerJoined(data: any): void {
    // 1. 기본 검증
    if (!this.roomId) return;
    const peerId = data?.socketId || data?.from;
    const myId = signalingService.getSocketId();
    if (!peerId || peerId === myId) return;


    // 🚀 [핵심 1] 긴급 제동 (Emergency Brake)
    // 전송 중이었다면, Worker로부터 오는 모든 배치를 막아버림 (CPU 확보)
    if (this.isTransferring) {
        this.isProcessingBatch = true; // 배치 처리 중인 것으로 속여서 추가 요청 차단
        
        // 혹시 쌓여있는 청크가 있다면 무시하도록 플래그 설정 (이 플래그는 클래스에 추가 필요)
        // 여기서는 isProcessingBatch만으로도 Backpressure에 의해 Worker가 멈추게 유도함
    }

    // 🚀 [핵심 2] 좀비 피어 즉시 사살 (Zombie Kill)
    // 기존에 연결된 피어 중, 새로 들어온 피어와 ID가 다르더라도
    // "연결 상태가 좋지 않거나" "오류가 있는" 피어는 모두 정리
    // (특히 1:1 전송 상황이라면 무조건 기존 연결을 끊는 게 안전함)
    if (this.peers.size > 0) {
        for (const [pid, peer] of this.peers) {
            // 기존 피어 강제 종료
            peer.destroy();
            this.peers.delete(pid);
        }
        // UI 업데이트
        this.emit('peer-disconnected', { peerId: 'all', reason: 'new-connection-reset' });
    }

    // 3. 약간의 딜레이 후 연결 시도 (이벤트 루프 숨통 트이기)
    setTimeout(() => {
        this.addPeer(peerId, true);
        
        // 연결 시도 후 1초 뒤에 Worker 다시 풀어줌 (연결이 실패하더라도 복구)
        setTimeout(() => {
            this.isProcessingBatch = false;
        }, 1000);
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
    
    // JSON 메시지 처리
    if (typeof data === 'string' || (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 123)) {
      try {
        const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
        const msg = JSON.parse(str);
        this.handleControlMessage(peerId, msg);
      } catch (e) {
        // JSON 파싱 실패 - 무시
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

    switch (msg.type) {
      case 'KEEP_ALIVE':
        // Keep-alive 메시지는 무시 (연결 유지 목적)
        return;
        
      case 'TRANSFER_READY':
        if (peer) {
          peer.ready = true;
          
          // 이미 완료된 피어인지 확인
          if (this.completedPeersInSession.has(peerId)) {
            logInfo('[SwarmManager]', `Peer ${peerId} already completed, ignoring TRANSFER_READY`);
            return;
          }
          
          
          // 🚀 [핵심 수정] TRANSFER_READY를 받으면 즉시 Manifest 전송
          // 이제 Receiver가 완전히 준비되었다는 신호이므로 안전하게 전송 가능
          if (this.pendingManifest) {
            this.sendManifestToPeer(peer);
          }
          
          logInfo('[SwarmManager]', `Peer ready: ${peerId}`);
          this.emit('peer-ready', peerId);
          
          // 🚀 [핵심 수정] 즉시 전송 시작 - 대기열 로직 제거
          // 이전 전송 완료 여부와 상관없이 ready 피어가 있으면 즉시 시작
          const readyPeers = this.getConnectedPeers().filter(p => p.ready && !this.completedPeersInSession.has(p.id));
          
          if (readyPeers.length > 0 && !this.isTransferring) {
            logInfo('[SwarmManager]', `Ready peers available, starting transfer immediately...`);
            this.startTransferWithReadyPeers();
            return;
          } else if (this.isTransferring) {
          }
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
   * 1:1 상황: 즉시 전송 시작
   * 1:N 상황: 10초 대기 후 ready된 피어들에게 동시 전송
   */
  private checkAllPeersReady(): void {
    const connectedPeers = this.getConnectedPeers();
    
    // 이미 완료된 피어는 제외하고 계산
    const pendingPeers = connectedPeers.filter(p => !this.completedPeersInSession.has(p.id));
    const readyPeers = pendingPeers.filter(p => p.ready);
    const notReadyPeers = pendingPeers.filter(p => !p.ready);

    logInfo('[SwarmManager]', `checkAllPeersReady: connected=${connectedPeers.length}, pending=${pendingPeers.length}, ready=${readyPeers.length}, notReady=${notReadyPeers.length}`);

    // 전송 중이면 무시 (대기열 로직에서 처리)
    if (this.isTransferring) {
      logInfo('[SwarmManager]', 'Transfer in progress, skipping ready check');
      return;
    }

    // ready 피어가 없으면 대기
    if (readyPeers.length === 0) {
      return;
    }

    // 🚀 [핵심] 1:1 상황 판단: 연결된 피어가 1명이고 그 피어가 ready
    const is1to1 = connectedPeers.length === 1 && readyPeers.length === 1;
    
    if (is1to1) {
      // 1:1 상황: 즉시 전송 시작
      this.clearReadyTimeout();
      logInfo('[SwarmManager]', '1:1 situation detected. Starting transfer immediately...');
      this.emit('all-peers-ready');
      this.startTransferWithReadyPeers();
      return;
    }

    // 🚀 [핵심] 1:N 상황: 모든 대기 중인 피어가 ready면 즉시 시작
    const allPendingReady = pendingPeers.length > 0 && pendingPeers.every(p => p.ready);
    if (allPendingReady) {
      this.clearReadyTimeout();
      logInfo('[SwarmManager]', `All ${readyPeers.length} pending peers ready. Starting transfer immediately...`);
      this.emit('all-peers-ready');
      this.startTransferWithReadyPeers();
      return;
    }

    // 🚀 [핵심] 1:N 상황: 첫 번째 ready 피어가 나타나면 10초 타이머 시작
    if (readyPeers.length > 0 && !this.readyTimeout) {
      logInfo('[SwarmManager]', `1:N situation. First peer ready. Starting ${READY_WAIT_TIME_1N/1000}s countdown...`);
      this.emit('ready-countdown-start', { 
        readyCount: readyPeers.length, 
        totalCount: pendingPeers.length,
        waitTime: READY_WAIT_TIME_1N 
      });
      
      this.readyTimeout = setTimeout(() => {
        this.readyTimeout = null;
        
        // 타임아웃 시점에 다시 상태 확인
        const currentPendingPeers = this.getConnectedPeers().filter(p => !this.completedPeersInSession.has(p.id));
        const currentReadyPeers = currentPendingPeers.filter(p => p.ready);
        
        if (currentReadyPeers.length > 0 && !this.isTransferring) {
          logInfo('[SwarmManager]', `Timeout reached. Starting with ${currentReadyPeers.length} ready peers...`);
          this.startTransferWithReadyPeers();
        }
      }, READY_WAIT_TIME_1N);
    }

    // 진행 상황 업데이트
    this.emit('ready-status', { 
      readyCount: readyPeers.length, 
      totalCount: pendingPeers.length 
    });
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
    const connectedPeers = this.getConnectedPeers();
    const readyPeers = connectedPeers.filter(p => p.ready && !this.completedPeersInSession.has(p.id));
    
    if (readyPeers.length === 0) {
      logError('[SwarmManager]', 'No ready peers to start transfer');
      this.emit('transfer-failed', 'No receivers ready');
      return;
    }
    
    // 🚀 [핵심 수정] 이미 전송 중이어도 새로운 ready 피어가 있으면 즉시 시작
    // 기존 전송 중단하고 새로운 전송 시작
    if (this.isTransferring) {
      logInfo('[SwarmManager]', `Transfer already in progress, but restarting for ${readyPeers.length} new ready peers`);
      this.isTransferring = false;
    }
    
    // Not-ready 피어들에게 전송 시작 알림 (연결은 유지)
    const notReadyPeers = connectedPeers.filter(p => !p.ready && !this.completedPeersInSession.has(p.id));
    for (const peer of notReadyPeers) {
      try {
        peer.send(JSON.stringify({
          type: 'TRANSFER_STARTED_WITHOUT_YOU',
          message: 'Transfer started with other receivers. You can start download when current transfer completes.'
        }));
      } catch (e) { /* ignore */ }
    }

    // 현재 전송 대상 피어 기록
    this.currentTransferPeers = new Set(readyPeers.map(p => p.id));
    
    logInfo('[SwarmManager]', `🚀 Starting transfer to ${readyPeers.length} peer(s): ${[...this.currentTransferPeers].join(', ')}`);
    
    this.emit('transfer-batch-start', { peerCount: readyPeers.length });
    
    // 🚀 [핵심 수정] Manifest 전송 후 전송 시작
    for (const peer of readyPeers) {
      try {
        if (this.pendingManifest) {
          peer.send(JSON.stringify({ type: 'MANIFEST', manifest: this.pendingManifest }));
        }
      } catch (e) {
        logError('[SwarmManager]', `Failed to send manifest to peer ${peer.id}:`, e);
      }
    }
    
    this.startTransfer();
  }

  /**
   * 🚀 [대기열] 현재 전송 완료 체크 및 대기열 처리
   * 
   * 전송 완료 후:
   * 1. 대기열에 피어가 있으면 즉시 다음 전송 시작
   * 2. 대기 중인 피어(연결됐지만 아직 Start Download 안 누름)가 있으면 대기
   * 3. 모든 피어가 완료되면 Transfer Success UI 표시
   */
  private checkTransferComplete(): void {
    
    logInfo('[SwarmManager]', `checkTransferComplete: currentTransferPeers=${this.currentTransferPeers.size}, isTransferring=${this.isTransferring}, completedPeers=${this.completedPeersInSession.size}`);
    
    // 🚀 [핵심 수정] 현재 전송 대상 피어가 모두 완료되었는지 확인
    // isTransferring이 false여도 currentTransferPeers가 비어있으면 완료 체크 진행
    if (this.currentTransferPeers.size > 0) {
      // 아직 전송 중인 피어가 있음
      logInfo('[SwarmManager]', `Still waiting for ${this.currentTransferPeers.size} peer(s) to complete`);
      return;
    }
    
    // 완료된 피어가 없으면 무시
    if (this.completedPeersInSession.size === 0) {
      return;
    }
    
    logInfo('[SwarmManager]', 'Current transfer batch complete');
    this.isTransferring = false;
      
      // 1. 대기열에 피어가 있으면 즉시 다음 전송 시작
      if (this.transferQueue.length > 0) {
        logInfo('[SwarmManager]', `Queue has ${this.transferQueue.length} peers. Starting next transfer immediately...`);
        this.emit('preparing-next-transfer', { queueSize: this.transferQueue.length });
        
        // 약간의 딜레이 후 대기열 처리 (UI 업데이트 시간 확보)
        setTimeout(() => this.processQueue(), 100);
        return;
      }
      
      // 2. 대기 중인 피어가 있는지 확인 (연결되어 있지만 아직 ready하지 않은 피어)
      const waitingPeers = this.getConnectedPeers().filter(
        p => !p.ready && !this.completedPeersInSession.has(p.id)
      );
      
      // 3. 이미 ready 상태지만 아직 전송 안 받은 피어 확인
      const readyButNotTransferred = this.getConnectedPeers().filter(
        p => p.ready && !this.completedPeersInSession.has(p.id)
      );
      
      if (readyButNotTransferred.length > 0) {
        // ready 상태인 피어가 있으면 즉시 전송 시작
        logInfo('[SwarmManager]', `${readyButNotTransferred.length} ready peers waiting. Starting transfer...`);
        this.startTransferWithReadyPeers();
        return;
      }
      
      if (waitingPeers.length > 0) {
        logInfo('[SwarmManager]', `${waitingPeers.length} peers still waiting (not ready yet). Ready for next transfer.`);
        
        // 대기 중인 피어들에게 다운로드 가능 알림
        for (const peer of waitingPeers) {
          try {
            peer.send(JSON.stringify({ 
              type: 'READY_FOR_DOWNLOAD',
              message: 'Previous transfer completed. You can now start your download.'
            }));
          } catch (e) { /* ignore */ }
        }
        
        this.emit('ready-for-next', { 
          waitingCount: waitingPeers.length,
          completedCount: this.completedPeersInSession.size
        });
        return;
      }
      
      // 4. 모든 연결된 피어가 완료됨 - Transfer Success!
      const connectedPeers = this.getConnectedPeers();
      
      const allConnectedCompleted = connectedPeers.length > 0 && 
        connectedPeers.every(p => this.completedPeersInSession.has(p.id));
      
      
    if (allConnectedCompleted || (connectedPeers.length === 0 && this.completedPeersInSession.size > 0)) {
      logInfo('[SwarmManager]', `🎉 All transfers complete! ${this.completedPeersInSession.size} receivers finished.`);
      
      // 🚀 [핵심 수정] 완료 후 추가 메시지 처리 방지
      this.isTransferring = false;
      
      this.emit('all-transfers-complete');
      
      // 🚀 [추가] 완료 이벤트 발생 후 약간의 딜레이를 두고 cleanup 준비
      setTimeout(() => {
      }, 1000);
    } else {
      logInfo('[SwarmManager]', 'Transfer batch complete. Waiting for more receivers.');
      this.emit('batch-complete', { completedCount: this.completedPeersInSession.size });
    }
  }

  /**
   * 🚀 [대기열] 대기열 처리 - 다음 전송 시작
   * 대기열에 있는 피어들에게 즉시 전송 시작
   */
  private processQueue(): void {
    if (this.transferQueue.length === 0 || this.isTransferring) {
      return;
    }
    
    // 대기열의 피어들을 현재 전송 대상으로 설정
    const queuedPeerIds = [...this.transferQueue];
    this.transferQueue = [];
    
    // 유효한 피어만 필터링 (연결되어 있고 ready 상태인 피어)
    const validPeers: IPeerConnection[] = [];
    for (const peerId of queuedPeerIds) {
      const peer = this.peers.get(peerId);
      if (peer && peer.connected && peer.ready && !this.completedPeersInSession.has(peerId)) {
        validPeers.push(peer);
      } else {
        logInfo('[SwarmManager]', `Queued peer ${peerId} is no longer valid (connected=${peer?.connected}, ready=${peer?.ready})`);
      }
    }
    
    if (validPeers.length > 0) {
      this.currentTransferPeers = new Set(validPeers.map(p => p.id));
      
      // 🚀 [핵심] 대기열 피어들에게 전송 시작 알림 (TRANSFER_STARTING)
      // ReceiverView에서 이 메시지를 받으면 QUEUED -> RECEIVING 상태로 전환
      for (const peer of validPeers) {
        try {
          peer.send(JSON.stringify({ type: 'TRANSFER_STARTING' }));
        } catch (e) { /* ignore */ }
      }
      
      this.emit('transfer-batch-start', { peerCount: validPeers.length, fromQueue: true });
      
      // 🚀 [핵심] 대기열 초기화 이벤트 발생 (SenderView UI 업데이트용)
      this.emit('queue-cleared', { processedCount: validPeers.length });
      
      this.startTransfer();
    } else {
      logInfo('[SwarmManager]', 'No valid peers in queue, checking for other ready peers...');
      // 대기열이 비었지만 다른 ready 피어가 있을 수 있음
      this.checkTransferComplete();
    }
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

  private emitProgress(progressData: any): void {
    const elapsed = (performance.now() - this.transferStartTime) / 1000;
    const speed = elapsed > 0 ? this.totalBytesSent / elapsed : 0;

    this.emit('progress', {
      ...progressData,
      totalBytesSent: this.totalBytesSent,
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
    this.files = [];
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
