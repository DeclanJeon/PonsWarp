import type { TransferEvent, TransferRole } from './events';
import type { TransferState } from './state';

export interface SignalingPort {
  connect(): Promise<void>;
  join(roomId: string): Promise<void>;
  leave?(): Promise<void> | void;
  send(message: unknown): Promise<void> | void;
  onMessage(handler: (message: unknown) => void): () => void;
}

export interface PeerConnectionPort {
  create(): Promise<PeerPort> | PeerPort;
}

export interface PeerPort {
  connect(): Promise<void>;
  close?(): Promise<void> | void;
  send(data: unknown): Promise<void> | void;
  onMessage(handler: (data: unknown) => void): () => void;
  onClose?(handler: () => void): () => void;
}

export interface WriterPort {
  write(chunk: unknown, offset?: number): Promise<void> | void;
  flush?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface ClockPort {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TransferOutputPort {
  emit(event: TransferEvent): void;
  setState?(state: TransferState): void;
}

export interface EventOutputPort {
  emit(event: TransferEvent): void;
}

export interface StateOutputPort {
  setState(state: TransferState): void;
}

export interface CloudDropPort {
  create(input: unknown): Promise<unknown>;
  upload(shareId: string, data: unknown, offset?: number): Promise<unknown>;
  complete(shareId: string): Promise<unknown>;
  cancel(shareId: string): Promise<void>;
}

export interface TransferPorts {
  signaling: SignalingPort;
  peer: PeerConnectionPort;
  writer?: WriterPort;
  clock?: ClockPort;
  output?: TransferOutputPort;
  cloudDrop?: CloudDropPort;
}

export type PeerFactoryPort = PeerConnectionPort;
export type Signaling = SignalingPort;
export type Writer = WriterPort;
export type Clock = ClockPort;

export type RolePortMap = {
  role: TransferRole;
  ports: TransferPorts;
};
