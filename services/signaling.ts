import { io, Socket } from 'socket.io-client';
import { SIGNALING_SERVER_URL } from '../constants';

type SignalHandler = (data: any) => void;

// TURN 설정 관련 타입 정의
export interface TurnCredentials {
  iceServers: RTCIceServer[];
  turnServerStatus: {
    primary: {
      connected: boolean;
      url: string;
      error: string | null;
      responseTime: number;
    };
    fallback: Array<{
      url: string;
      connected: boolean;
      error: string | null;
      responseTime: number;
    }>;
  };
  ttl: number;
  timestamp: number;
  roomId: string;
  message?: string; // 추가된 속성
}

export interface TurnConfigRequest {
  roomId: string;
  forceRefresh?: boolean;
}

export interface TurnConfigResponse {
  success: boolean;
  data?: TurnCredentials;
  error?: string;
  message?: string;
  retryAfter?: number;
}

class SignalingService {
  private socket: Socket | null = null;
  private handlers: Record<string, SignalHandler[]> = {};
  private isConnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private connectionPromise: Promise<void> | null = null;

  public async connect(): Promise<void> {
    if (this.socket?.connected) {
      console.log('[Signaling] ✅ Already connected:', this.socket.id);
      return Promise.resolve();
    }

    if (this.isConnecting && this.connectionPromise) {
      console.log('[Signaling] ⏳ Connection already in progress, waiting...');
      return this.connectionPromise;
    }

    this.isConnecting = true;
    console.log('[Signaling] 🔌 Initiating connection to:', SIGNALING_SERVER_URL);

    this.connectionPromise = new Promise((resolve, reject) => {
      // 🚨 [수정] 옵션 최적화: 불필요한 재연결 시도를 줄이고 타임아웃 설정
      this.socket = io(SIGNALING_SERVER_URL, {
        transports: ['websocket'], // polling 제외 (속도 향상)
        reconnectionAttempts: 3,
        timeout: 5000,
        autoConnect: true,
        forceNew: true // 🚨 [핵심] 기존 소켓 재사용 금지 (좀비 세션 방지)
      });

      this.socket.on('connect', () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        console.log('✅ [Signaling] Connected to signaling server:', this.socket?.id);
        this.emit('connected', this.socket?.id);
        resolve();
      });

      this.socket.on('connect_error', (error) => {
        this.reconnectAttempts++;
        console.error(`❌ [Signaling] Connection error (${this.reconnectAttempts}/${this.maxReconnectAttempts}):`, error.message);
        
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          this.isConnecting = false;
          console.error('[Signaling] Max reconnection attempts reached');
          this.emit('connection-failed', error);
          reject(error);
        }
      });

      this.socket.on('disconnect', (reason) => {
        this.isConnecting = false;
        console.log('[Signaling] 🔌 Disconnected:', reason);
        
        if (reason === 'io server disconnect') {
          console.log('[Signaling] Server disconnected, attempting reconnect...');
          this.socket?.connect();
        }
      });

      this.socket.on('reconnect', (attemptNumber) => {
        console.log(`✅ [Signaling] Reconnected after ${attemptNumber} attempts`);
        this.reconnectAttempts = 0;
      });

      this.socket.on('reconnect_failed', () => {
        this.isConnecting = false;
        console.error('❌ [Signaling] Reconnection failed permanently');
        const error = new Error('Reconnection failed');
        this.emit('connection-failed', error);
        reject(error);
      });

      // 이벤트 핸들러 등록
      this.socket.on('joined-room', (data) => {
        console.log('📢 [Signaling] joined-room:', data);
        this.emit('joined-room', data);
      });

      this.socket.on('room-users', (users) => {
        console.log('📢 [Signaling] room-users:', users);
        this.emit('room-users', users);
      });

      this.socket.on('peer-joined', (data) => {
        console.log('📢 [Signaling] peer-joined:', data);
        this.emit('peer-joined', data);
      });

      this.socket.on('user-left', (data) => {
        console.log('📢 [Signaling] user-left:', data);
        this.emit('user-left', data);
      });
      
      this.socket.on('offer', (data) => {
        console.log('📢 [Signaling] offer received from:', data.from);
        this.emit('offer', data);
      });
      
      this.socket.on('answer', (data) => {
        console.log('📢 [Signaling] answer received from:', data.from);
        this.emit('answer', data);
      });
      
      this.socket.on('ice-candidate', (data) => {
        console.log('📢 [Signaling] ice-candidate from:', data.from);
        this.emit('ice-candidate', data);
      });

      this.socket.on('room-full', (data) => {
        console.warn('⚠️ [Signaling] Room full:', data.roomId);
        this.emit('room-full', data);
      });
    });

    return this.connectionPromise;
  }

  public async joinRoom(roomId: string): Promise<void> {
    if (!this.socket?.connected) {
      console.log('[Signaling] Not connected, waiting...');
      await this.connect();
    }
    
    console.log('[Signaling] 🚪 Joining room:', roomId);
    this.socket!.emit('join-room', roomId);
  }

  /**
   * 🚀 [Multi-Receiver] target 파라미터 추가 - 특정 피어에게만 전달
   */
  public sendOffer(roomId: string, offer: RTCSessionDescriptionInit, target?: string) {
    if (!this.socket?.connected) {
      console.error('❌ [Signaling] Cannot send offer: Not connected');
      return;
    }
    
    console.log('[Signaling] 📤 Sending offer to:', target || roomId);
    this.socket.emit('offer', { roomId, offer, target });
  }

  public sendAnswer(roomId: string, answer: RTCSessionDescriptionInit, target?: string) {
    if (!this.socket?.connected) {
      console.error('❌ [Signaling] Cannot send answer: Not connected');
      return;
    }
    
    console.log('[Signaling] 📤 Sending answer to:', target || roomId);
    this.socket.emit('answer', { roomId, answer, target });
  }

  public sendCandidate(roomId: string, candidate: RTCIceCandidate, target?: string) {
    if (!this.socket?.connected) {
      console.error('❌ [Signaling] Cannot send ICE candidate: Not connected');
      return;
    }
    
    console.log('[Signaling] 📤 Sending ICE candidate to:', target || roomId);
    this.socket.emit('ice-candidate', { roomId, candidate, target });
  }

  public on(event: string, handler: SignalHandler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
  }

  public off(event: string, handler: SignalHandler) {
    if (!this.handlers[event]) return;
    this.handlers[event] = this.handlers[event].filter(h => h !== handler);
  }

  private emit(event: string, data: any) {
    this.handlers[event]?.forEach(h => h(data));
  }

  public getSocket(): Socket | null {
    return this.socket;
  }

  public getSocketId() {
    return this.socket?.id;
  }

  public async leaveRoom(roomId: string): Promise<void> {
    if (!this.socket?.connected) {
      return;
    }
    
    console.log('[Signaling] 🚪 Leaving room:', roomId);
    this.socket.emit('leave-room', roomId);
  }
  
  // 🚨 [핵심] 클린업 강화
  public disconnect() {
    if (this.socket) {
      console.log('[Signaling] Disconnecting...');
      this.socket.removeAllListeners(); // 모든 리스너 제거 (메모리 누수 방지)
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnecting = false;
  }

  public isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  // TURN 설정 관련 메서드 추가 (기존 유지)
  public async requestTurnConfig(roomId: string): Promise<TurnConfigResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        const error: TurnConfigResponse = {
          success: false,
          error: 'NOT_CONNECTED',
          message: '시그널링 서버에 연결되지 않았습니다.'
        };
        reject(error);
        return;
      }

      console.log('[Signaling] 🔄 Requesting TURN config for room:', roomId);

      // Socket.IO 이벤트로 TURN 설정 요청
      this.socket.emit('request-turn-config', { roomId }, (response: TurnConfigResponse) => {
        if (response.success && response.data) {
          console.log('[Signaling] ✅ TURN config received:', {
            roomId,
            iceServerCount: response.data.iceServers.length,
            ttl: response.data.ttl,
            turnServerConnected: response.data.turnServerStatus.primary.connected
          });
          resolve(response);
        } else {
          console.error('[Signaling] ❌ TURN config request failed:', response);
          reject(response);
        }
      });
    });
  }

  public async refreshTurnCredentials(roomId: string, currentUsername: string): Promise<TurnConfigResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        const error: TurnConfigResponse = {
          success: false,
          error: 'NOT_CONNECTED',
          message: '시그널링 서버에 연결되지 않았습니다.'
        };
        reject(error);
        return;
      }

      console.log('[Signaling] 🔄 Refreshing TURN credentials for room:', roomId);

      this.socket.emit('refresh-turn-credentials', { roomId, currentUsername }, (response: TurnConfigResponse) => {
        if (response.success) {
          console.log('[Signaling] ✅ TURN credentials refreshed:', {
            roomId,
            oldUsername: currentUsername,
            message: response.data?.message
          });
          resolve(response);
        } else {
          console.error('[Signaling] ❌ TURN credentials refresh failed:', response);
          reject(response);
        }
      });
    });
  }

  public async checkTurnServerStatus(): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        reject({
          success: false,
          error: 'NOT_CONNECTED',
          message: '시그널링 서버에 연결되지 않았습니다.'
        });
        return;
      }

      console.log('[Signaling] 🔄 Checking TURN server status');

      this.socket.emit('check-turn-server-status', {}, (response: any) => {
        if (response.success) {
          console.log('[Signaling] ✅ TURN server status received:', response.data);
          resolve(response);
        } else {
          console.error('[Signaling] ❌ TURN server status check failed:', response);
          reject(response);
        }
      });
    });
  }

  public async testTurnConnection(roomId = 'test-room'): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        reject({
          success: false,
          error: 'NOT_CONNECTED',
          message: '시그널링 서버에 연결되지 않았습니다.'
        });
        return;
      }

      console.log('[Signaling] 🧪 Testing TURN connection for room:', roomId);

      this.socket.emit('test-turn-connection', { testRoomId: roomId }, (response: any) => {
        if (response.success) {
          console.log('[Signaling] ✅ TURN connection test initiated:', response.data);
          resolve(response);
        } else {
          console.error('[Signaling] ❌ TURN connection test failed:', response);
          reject(response);
        }
      });
    });
  }

  // TURN 연결 테스트 결과 전송
  public sendTurnConnectionTestResult(roomId: string, result: any): void {
    if (!this.socket?.connected) {
      console.error('[Signaling] Cannot send TURN test result: Not connected');
      return;
    }

    console.log('[Signaling] 📤 Sending TURN connection test result:', { roomId, result });

    this.socket.emit('turn-connection-test-result', {
      testRoomId: roomId,
      result: {
        success: result.success,
        error: result.error,
        connectionTime: result.connectionTime,
        timestamp: Date.now(),
        userAgent: navigator.userAgent
      }
    });
  }

  // TURN 관련 이벤트 리스너 등록
  public onTurnServerStatusUpdate(callback: (data: any) => void): void {
    this.on('turn-server-status-update', callback);
  }

  public onTurnTestResult(callback: (data: any) => void): void {
    this.on('turn-test-result', callback);
  }

  // REST API를 통한 TURN 설정 요청 (폴백용)
  public async requestTurnConfigViaHttp(roomId: string): Promise<TurnConfigResponse> {
    try {
      console.log('[Signaling] 🔄 Requesting TURN config via HTTP for room:', roomId);

      const response = await fetch(`${SIGNALING_SERVER_URL}/api/turn-config?roomId=${encodeURIComponent(roomId)}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': navigator.userAgent
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: TurnConfigResponse = await response.json();

      if (data.success && data.data) {
        console.log('[Signaling] ✅ TURN config received via HTTP:', {
          roomId,
          iceServerCount: data.data.iceServers.length,
          ttl: data.data.ttl
        });
      }

      return data;
    } catch (error) {
      console.error('[Signaling] ❌ TURN config request via HTTP failed:', error);
      return {
        success: false,
        error: 'HTTP_REQUEST_FAILED',
        message: `HTTP 요청 실패: ${error.message}`
      };
    }
  }

  // REST API를 통한 TURN 자격 증명 갱신
  public async refreshTurnCredentialsViaHttp(roomId: string, currentUsername: string): Promise<TurnConfigResponse> {
    try {
      console.log('[Signaling] 🔄 Refreshing TURN credentials via HTTP for room:', roomId);

      const response = await fetch(`${SIGNALING_SERVER_URL}/api/turn-refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': navigator.userAgent
        },
        body: JSON.stringify({
          roomId,
          currentUsername,
          force: false
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: TurnConfigResponse = await response.json();

      if (data.success) {
        console.log('[Signaling] ✅ TURN credentials refreshed via HTTP:', {
          roomId,
          oldUsername: currentUsername,
          message: data.data?.message
        });
      }

      return data;
    } catch (error) {
      console.error('[Signaling] ❌ TURN credentials refresh via HTTP failed:', error);
      return {
        success: false,
        error: 'HTTP_REQUEST_FAILED',
        message: `HTTP 요청 실패: ${error.message}`
      };
    }
  }
}

export const signalingService = new SignalingService();
