// 공통 피어 연결 인터페이스
export interface IPeerConnection {
  readonly id: string;
  connected: boolean;
  ready: boolean;
  
  on(event: string, handler: (data: any) => void): void;
  off(event: string, handler: (data: any) => void): void;
  signal(data: any): void | Promise<void>;
  send(data: ArrayBuffer | ArrayBufferView | string): boolean | void;
  getBufferedAmount(): number;
  getState(): any;
  destroy(): void;
}

// 공통 피어 상태 인터페이스
export interface IPeerState {
  id: string;
  connected: boolean;
  bufferedAmount: number;
  ready: boolean;
}