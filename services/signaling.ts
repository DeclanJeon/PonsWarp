import { io, Socket } from 'socket.io-client';
import { SIGNALING_SERVER_URL } from '../constants';

type SignalHandler = (data: any) => void;

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
      this.socket = io(SIGNALING_SERVER_URL, {
        transports: ['websocket', 'polling'],
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: 1000,
        timeout: 10000,
        autoConnect: true,
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

  public sendOffer(roomId: string, offer: RTCSessionDescriptionInit) {
    if (!this.socket?.connected) {
      console.error('❌ [Signaling] Cannot send offer: Not connected');
      return;
    }
    
    console.log('[Signaling] 📤 Sending offer to room:', roomId);
    this.socket.emit('offer', { roomId, offer });
  }

  public sendAnswer(roomId: string, answer: RTCSessionDescriptionInit) {
    if (!this.socket?.connected) {
      console.error('❌ [Signaling] Cannot send answer: Not connected');
      return;
    }
    
    console.log('[Signaling] 📤 Sending answer to room:', roomId);
    this.socket.emit('answer', { roomId, answer });
  }

  public sendCandidate(roomId: string, candidate: RTCIceCandidate) {
    if (!this.socket?.connected) {
      console.error('❌ [Signaling] Cannot send ICE candidate: Not connected');
      return;
    }
    
    console.log('[Signaling] 📤 Sending ICE candidate to room:', roomId);
    this.socket.emit('ice-candidate', { roomId, candidate });
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
  
  public disconnect() {
    if (this.socket) {
      console.log('[Signaling] 🔌 Manually disconnecting');
      this.socket.disconnect();
      this.socket = null;
      this.isConnecting = false;
      this.connectionPromise = null;
    }
  }

  public isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}

export const signalingService = new SignalingService();
