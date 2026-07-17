/**
 * Main-thread facade over bulk-encrypt.worker.
 * Worker: read + AES-GCM E2E encrypt
 * Main: paced DataChannel send only
 */
import { PREPARE_AHEAD_BYTES } from '../utils/constants';
import { logDebug, logWarn } from '../utils/logger';

export type PreparedBulkPacket = {
  sequence: number;
  offset: number;
  payloadSize: number;
  packet: ArrayBuffer;
};

export type BulkEncryptStartParams = {
  files: File[];
  totalSize: number;
  startOffset: number;
  startSequence: number;
  startFileIndex: number;
  startFileOffset: number;
  chunkSize: number;
  prepareAheadBytes?: number;
  encryptionEnabled: boolean;
  sessionKey?: Uint8Array | null;
  randomPrefix?: Uint8Array | null;
  startNonce: number;
};

type WorkerPrepared = {
  type: 'prepared';
  sequence: number;
  offset: number;
  payloadSize: number;
  packet: ArrayBuffer;
};

type WorkerMsg =
  | { type: 'ready' }
  | WorkerPrepared
  | { type: 'complete'; payload?: { nextNonce?: number } }
  | { type: 'error'; payload?: { message?: string } };

export class BulkEncryptProducer {
  private worker: Worker | null = null;
  private queue: PreparedBulkPacket[] = [];
  private waiters: Array<() => void> = [];
  private done = false;
  private failed: Error | null = null;
  private nextNonce = 0;
  private started = false;

  static isSupported(): boolean {
    return typeof Worker !== 'undefined';
  }

  async start(params: BulkEncryptStartParams): Promise<void> {
    this.close();
    this.done = false;
    this.failed = null;
    this.queue = [];
    this.waiters = [];
    this.nextNonce = params.startNonce;
    this.started = true;

    this.worker = new Worker(
      new URL('../workers/bulk-encrypt.worker.ts', import.meta.url),
      { type: 'module' }
    );

    await new Promise<void>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker missing'));
        return;
      }

      const onReadyError = (event: ErrorEvent) => {
        cleanup();
        reject(new Error(event.message || 'Bulk encrypt worker failed'));
      };

      const onReadyMessage = (event: MessageEvent<WorkerMsg>) => {
        if (event.data?.type === 'ready') {
          cleanup();
          resolve();
          return;
        }
        if (event.data?.type === 'error') {
          cleanup();
          reject(new Error(event.data.payload?.message || 'Worker error'));
        }
      };

      const cleanup = () => {
        this.worker?.removeEventListener('message', onReadyMessage as EventListener);
        this.worker?.removeEventListener('error', onReadyError as EventListener);
      };

      this.worker.addEventListener('message', onReadyMessage as EventListener);
      this.worker.addEventListener('error', onReadyError);
    });

    this.worker.onmessage = (event: MessageEvent<WorkerMsg>) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'prepared') {
        this.queue.push({
          sequence: msg.sequence,
          offset: msg.offset,
          payloadSize: msg.payloadSize,
          packet: msg.packet,
        });
        this.notify();
        return;
      }
      if (msg.type === 'complete') {
        this.done = true;
        if (typeof msg.payload?.nextNonce === 'number') {
          this.nextNonce = msg.payload.nextNonce;
        }
        this.notify();
        return;
      }
      if (msg.type === 'error') {
        this.failed = new Error(msg.payload?.message || 'Bulk encrypt worker error');
        this.done = true;
        this.notify();
      }
    };

    this.worker.onerror = event => {
      this.failed = new Error(event.message || 'Bulk encrypt worker crashed');
      this.done = true;
      this.notify();
    };

    const toArrayBuffer = (view: Uint8Array): ArrayBuffer => {
      const copy = new Uint8Array(view.byteLength);
      copy.set(view);
      return copy.buffer;
    };
    const sessionKey = params.sessionKey
      ? toArrayBuffer(params.sessionKey)
      : undefined;
    const randomPrefix = params.randomPrefix
      ? toArrayBuffer(params.randomPrefix)
      : undefined;

    this.worker.postMessage({
      type: 'start',
      payload: {
        files: params.files,
        fileSizes: params.files.map(f => f.size),
        totalSize: params.totalSize,
        startOffset: params.startOffset,
        startSequence: params.startSequence,
        startFileIndex: params.startFileIndex,
        startFileOffset: params.startFileOffset,
        chunkSize: params.chunkSize,
        prepareAheadBytes: params.prepareAheadBytes ?? PREPARE_AHEAD_BYTES,
        encryptionEnabled: params.encryptionEnabled,
        sessionKey,
        randomPrefix,
        startNonce: params.startNonce,
      },
    });

    logDebug(
      '[BulkEncryptProducer]',
      `started encrypt=${params.encryptionEnabled} chunk=${params.chunkSize}`
    );
  }

  async next(): Promise<PreparedBulkPacket | null> {
    for (;;) {
      if (this.failed) throw this.failed;
      if (this.queue.length > 0) {
        return this.queue.shift()!;
      }
      if (this.done) return null;
      await new Promise<void>(resolve => {
        this.waiters.push(resolve);
      });
    }
  }

  /** Free worker queue budget after a packet is handed to DataChannel. */
  credit(packetByteLength: number): void {
    this.worker?.postMessage({
      type: 'credit',
      payload: { bytes: packetByteLength },
    });
  }

  updateChunkSize(chunkSize: number): void {
    this.worker?.postMessage({
      type: 'update-chunk-size',
      payload: { chunkSize },
    });
  }

  getNextNonce(): number {
    return this.nextNonce;
  }

  close(): void {
    if (!this.worker) {
      this.started = false;
      return;
    }
    try {
      this.worker.postMessage({ type: 'cancel' });
    } catch {
      // ignore
    }
    try {
      this.worker.terminate();
    } catch (error) {
      logWarn('[BulkEncryptProducer]', 'terminate failed', error);
    }
    this.worker = null;
    this.queue = [];
    this.done = true;
    this.started = false;
    this.notify();
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
