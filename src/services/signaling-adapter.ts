/**
 * Rust 시그널링 서버 어댑터
 * Socket.io 이벤트를 JSON Frame으로 변환하여 기존 코드와 호환성 유지
 */

import { TurnConfigResponse } from './signaling';

type MessageHandler = (data: unknown) => void;

interface RustMessage {
  type: string;
  payload: unknown;
}

class RustSignalingAdapter {
  private ws: WebSocket | null = null;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private socketId: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private url: string = '';
  private connectionPromise: Promise<void> | null = null;

  async connect(url: string): Promise<void> {
    // [FIX] 이미 연결되어 있거나 연결 중이면 기존 연결 재사용 (중복 연결 방지)
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log('[RustSignaling] ✅ Already connected:', this.socketId);
      return Promise.resolve();
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.url = url;

    this.connectionPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        console.error('[RustSignaling] Connection timeout after 5 seconds');
        reject(new Error('Connection timeout'));
        this.connectionPromise = null;
        // WebSocket이 있으면 닫아주어 상태를 정리
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
      }, 5000); // 10초에서 5초로 단축하여 더 빠른 실패 감지

      this.ws.onopen = () => {
        console.log('[RustSignaling] WebSocket opened');
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = event => {
        try {
          console.log('[RustSignaling] 📨 Raw message received:', event.data);
          const message: RustMessage = JSON.parse(event.data);

          if (message.type === 'Connected') {
            clearTimeout(timeout);
            const payload = message.payload as { socket_id: string };
            this.socketId = payload.socket_id;
            console.log('[RustSignaling] Connected:', this.socketId);
            this.emit('connected', this.socketId);
            resolve();
            this.connectionPromise = null;
          } else {
            this.handleMessage(message);
          }
        } catch (e) {
          console.error('[RustSignaling] Parse error:', e);
        }
      };

      this.ws.onerror = error => {
        console.error('[RustSignaling] Error:', error);
        if (this.ws?.readyState !== WebSocket.OPEN) {
          clearTimeout(timeout);
          reject(error);
          this.connectionPromise = null;
        }
      };

      this.ws.onclose = event => {
        console.log('[RustSignaling] Disconnected:', event.code, event.reason);
        this.emit('disconnect', { reason: event.reason });
        this.socketId = null;
        this.connectionPromise = null;
        this.attemptReconnect();
      };
    });

    return this.connectionPromise;
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[RustSignaling] Max reconnection attempts reached');
      this.emit('connection-failed', new Error('Max reconnection attempts'));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    setTimeout(() => {
      if (this.url && (!this.ws || this.ws.readyState === WebSocket.CLOSED)) {
        this.connect(this.url).catch(() => { });
      }
    }, delay);
  }

  private handleMessage(message: RustMessage) {
    console.log('[RustSignaling] 🔍 Handling message:', message.type, message.payload);
    const eventMap: Record<string, string> = {
      HeartbeatAck: 'heartbeat-ack',
      JoinedRoom: 'joined-room',
      RoomUsers: 'room-users',
      PeerJoined: 'peer-joined',
      UserLeft: 'user-left',
      RoomFull: 'room-full',
      Offer: 'offer',
      Answer: 'answer',
      IceCandidate: 'ice-candidate',
      TurnConfig: 'turn-config',
      Error: 'error',
    };

    const eventName = eventMap[message.type] || message.type.toLowerCase();

    // 기본 변환 (snake_case -> camelCase)
    let payload = this.transformPayload(message.payload);

    // 🚨 [CRITICAL FIX] 호환성 매핑: Rust의 'sdp' 필드를 프론트엔드가 찾는 'offer'/'answer'로 복사
    // 이 부분이 없어서 연결이 안 되었던 것입니다.
    if (typeof payload === 'object' && payload !== null) {
      const payloadObj = payload as Record<string, unknown>;
      if (message.type === 'Offer') {
        console.log(
          '[RustSignaling] 🔍 [DEBUG] Before mapping - payload:',
          payload
        );
        console.log(
          '[RustSignaling] 🔍 [DEBUG] sdp field value:',
          payloadObj.sdp
        );
        payloadObj.offer = payloadObj.sdp;
        console.log(
          '[RustSignaling] 🔍 [DEBUG] After mapping - payload.offer:',
          payloadObj.offer
        );
        console.log('[RustSignaling] Mapped Offer SDP:', payloadObj);
      }
      if (message.type === 'Answer') {
        console.log(
          '[RustSignaling] 🔍 [DEBUG] Before mapping - payload:',
          payload
        );
        console.log(
          '[RustSignaling] 🔍 [DEBUG] sdp field value:',
          payloadObj.sdp
        );
        payloadObj.answer = payloadObj.sdp;
        console.log(
          '[RustSignaling] 🔍 [DEBUG] After mapping - payload.answer:',
          payloadObj.answer
        );
        console.log('[RustSignaling] Mapped Answer SDP:', payloadObj);
      }
    }

    this.emit(eventName, payload);
  }

  private transformPayload(payload: unknown): unknown {
    if (payload === null || typeof payload !== 'object') {
      return payload;
    }

    if (Array.isArray(payload)) {
      return payload.map(item => this.transformPayload(item));
    }

    const obj = payload as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      // snake_case -> camelCase 변환
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      result[camelKey] = this.transformPayload(value);
    }

    return result;
  }

  private send(type: string, payload: Record<string, unknown>) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn(
        '[RustSignaling] Cannot send: WebSocket not open, current state:',
        this.ws?.readyState
      );
      // 연결이 끊어졌다면 자동으로 재연결 시도
      if (this.url && (!this.ws || this.ws.readyState === WebSocket.CLOSED)) {
        console.log(
          '[RustSignaling] Attempting to reconnect for send operation...'
        );
        this.connect(this.url).catch(() => { });
      }
      return;
    }

    // camelCase -> snake_case 변환
    const snakePayload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      const snakeKey = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
      snakePayload[snakeKey] = value;
    }
    this.ws.send(JSON.stringify({ type, payload: snakePayload }));
  }

  // API Methods
  async joinRoom(roomId: string): Promise<void> {
    console.log('[RustSignaling] Joining room:', roomId);
    this.send('JoinRoom', { roomId });
  }

  sendOffer(roomId: string, offer: RTCSessionDescriptionInit, target?: string) {
    // Rust 서버는 sdp 필드를 기대하므로 sdp 키에 JSON 문자열을 담아 보냅니다
    this.send('Offer', {
      roomId,
      sdp: JSON.stringify(offer),
      target: target || null,
    });
  }

  sendAnswer(
    roomId: string,
    answer: RTCSessionDescriptionInit,
    target?: string
  ) {
    this.send('Answer', {
      roomId,
      sdp: JSON.stringify(answer),
      target: target || null,
    });
  }

  sendCandidate(roomId: string, candidate: RTCIceCandidate, target?: string) {
    this.send('IceCandidate', {
      roomId,
      candidate: JSON.stringify(candidate),
      target: target || null,
    });
  }

  async requestTurnConfig(roomId: string): Promise<TurnConfigResponse> {
    return new Promise(resolve => {
      const handler = (data: unknown) => {
        this.off('turn-config', handler);
        resolve(data as TurnConfigResponse);
      };
      this.on('turn-config', handler);
      this.send('RequestTurnConfig', { roomId });
    });
  }

  leaveRoom(_roomId: string) {
    this.send('LeaveRoom', {});
  }

  on(event: string, handler: MessageHandler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  off(event: string, handler: MessageHandler) {
    const handlers = this.handlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) handlers.splice(index, 1);
    }
  }

  private emit(event: string, data: unknown) {
    this.handlers.get(event)?.forEach(h => h(data));
  }

  getSocketId() {
    return this.socketId;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.socketId = null;
    this.connectionPromise = null;
    this.handlers.clear();
  }
}

export const rustSignalingAdapter = new RustSignalingAdapter();
