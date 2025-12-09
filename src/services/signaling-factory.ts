/**
 * 시그널링 서비스 팩토리
 * 환경 변수에 따라 Node.js(Socket.io) 또는 Rust(WebSocket) 서버 선택
 */

import { signalingService } from './signaling';
import { rustSignalingAdapter } from './signaling-adapter';
import {
  USE_RUST_SIGNALING,
  RUST_SIGNALING_URL,
  SIGNALING_SERVER_URL,
} from '../utils/constants';

export interface ISignalingService {
  connect(): Promise<void>;
  joinRoom(roomId: string): Promise<void>;
  leaveRoom(roomId: string): void;
  sendOffer(
    roomId: string,
    offer: RTCSessionDescriptionInit,
    target?: string
  ): void;
  sendAnswer(
    roomId: string,
    answer: RTCSessionDescriptionInit,
    target?: string
  ): void;
  sendCandidate(
    roomId: string,
    candidate: RTCIceCandidate,
    target?: string
  ): void;
  requestTurnConfig(roomId: string): Promise<unknown>;
  on(event: string, handler: (data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;
  getSocketId(): string | null | undefined;
  isConnected(): boolean;
  disconnect(): void;
}

class SignalingFactory {
  private service: ISignalingService | null = null;
  private initialized = false;

  getService(): ISignalingService {
    if (!this.service) {
      if (USE_RUST_SIGNALING) {
        console.log('[SignalingFactory] Using Rust signaling server');
        this.service = rustSignalingAdapter as unknown as ISignalingService;
      } else {
        console.log('[SignalingFactory] Using Node.js signaling server');
        this.service = signalingService as unknown as ISignalingService;
      }
    }
    return this.service;
  }

  async connect(): Promise<void> {
    if (USE_RUST_SIGNALING) {
      await rustSignalingAdapter.connect(RUST_SIGNALING_URL);
    } else {
      await signalingService.connect();
    }

    this.initialized = true;
  }

  isUsingRust(): boolean {
    return USE_RUST_SIGNALING;
  }

  getServerUrl(): string {
    return USE_RUST_SIGNALING ? RUST_SIGNALING_URL : SIGNALING_SERVER_URL;
  }
}

export const signalingFactory = new SignalingFactory();

// 기본 export - 기존 코드 호환성 유지
export const getSignalingService = () => signalingFactory.getService();
