import { TransferManifest } from '../types/types';
import type { ISignalingService } from './signaling-factory';
import type { PeerConfig, SinglePeerConnection } from './singlePeerConnection';

export interface IFileWriter {
  initStorage(manifest: TransferManifest): Promise<void>;
  writeChunk(packet: ArrayBuffer): Promise<void>;
  cleanup(): Promise<void>;
  onProgress(
    cb: (progress: {
      progress: number;
      speed: number;
      bytesTransferred: number;
      totalBytes: number;
    }) => void
  ): void;
  onComplete(cb: (actualSize: number) => void): void;
  onError(cb: (err: string) => void): void;
  // Flow control
  onFlowControl?(cb: (action: 'PAUSE' | 'RESUME') => void): void;
  onResumeRequest?(cb: (offset: number, reason: string) => void): void;
  requestResumeFromCurrentOffset?(reason: string): boolean;
  forceResumeFromCurrentOffset?(reason: string): boolean;
  waitForIdle?(): Promise<void>;
  getContiguousReceivedOffset?(): number;
  // E2E encryption key setup
  setEncryptionKey?(sessionKey: Uint8Array, randomPrefix: Uint8Array): void;
}

export interface ReceiverServiceOptions {
  signaling?: ISignalingService;
  peerFactory?: (
    peerId: string,
    initiator: boolean,
    config: PeerConfig
  ) => SinglePeerConnection;
  writer?: IFileWriter;
  clock?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;
  output?: { emit?: (event: { type: string; data: unknown }) => void };
}

export type ReceiverSignalMessage = {
  from: string;
  offer?: unknown;
  candidate?: unknown;
  sdp?: unknown;
};

export type ReceiverProgressPayload =
  | number
  | {
      progress: number;
      speed: number;
      bytesTransferred: number;
      totalBytes: number;
    };
