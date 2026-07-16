import type {
  CryptoPlaneInMessage,
  CryptoPlaneOutMessage,
} from '../workers/crypto-plane.worker';

type Pending = {
  resolve: (value: ArrayBuffer | boolean) => void;
  reject: (error: Error) => void;
  kind: 'init' | 'encrypt' | 'decrypt' | 'reset';
};

type PoolWorker = {
  worker: Worker;
  pending: Map<number, Pending>;
  ready: boolean;
  inflight: number;
};

const DEFAULT_POOL_SIZE = 2;

/**
 * Small pool of crypto workers for parallel AES-GCM bulk frames.
 * Falls back to caller-provided main-thread path when workers unavailable.
 */
export class CryptoPlaneClient {
  private workers: PoolWorker[] = [];
  private nextRequestId = 1;
  private nextWorker = 0;
  private keyInitialized = false;
  private destroyed = false;
  private sessionKey: ArrayBuffer | null = null;
  private randomPrefix: ArrayBuffer | null = null;

  constructor(private readonly poolSize = DEFAULT_POOL_SIZE) {}

  public isAvailable(): boolean {
    return !this.destroyed && this.workers.length > 0 && this.keyInitialized;
  }

  public async ensureKey(
    sessionKey: Uint8Array,
    randomPrefix: Uint8Array
  ): Promise<boolean> {
    if (this.destroyed) return false;
    try {
      this.ensureWorkers();
      const keyBuf = sessionKey.buffer.slice(
        sessionKey.byteOffset,
        sessionKey.byteOffset + sessionKey.byteLength
      ) as ArrayBuffer;
      const prefixBuf = randomPrefix.buffer.slice(
        randomPrefix.byteOffset,
        randomPrefix.byteOffset + randomPrefix.byteLength
      ) as ArrayBuffer;
      this.sessionKey = keyBuf.slice(0);
      this.randomPrefix = prefixBuf.slice(0);

      await Promise.all(
        this.workers.map(w => this.initWorkerKey(w, keyBuf.slice(0), prefixBuf.slice(0)))
      );
      this.keyInitialized = true;
      return true;
    } catch {
      this.keyInitialized = false;
      return false;
    }
  }

  public async encryptPacket(params: {
    payload: ArrayBuffer;
    sequence: number;
    offset: number;
    nonceCounter: number;
  }): Promise<ArrayBuffer> {
    if (!this.isAvailable()) {
      throw new Error('Crypto plane worker unavailable');
    }
    const worker = this.pickWorker();
    const requestId = this.nextRequestId++;
    const payloadCopy = params.payload.slice(0);
    return await this.request<ArrayBuffer>(worker, {
      type: 'encrypt',
      requestId,
      payload: payloadCopy,
      sequence: params.sequence,
      offset: params.offset,
      nonceCounter: params.nonceCounter,
    }, [payloadCopy]);
  }

  public async decryptPacket(packet: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.isAvailable()) {
      throw new Error('Crypto plane worker unavailable');
    }
    const worker = this.pickWorker();
    const requestId = this.nextRequestId++;
    const packetCopy = packet.slice(0);
    return await this.request<ArrayBuffer>(worker, {
      type: 'decrypt',
      requestId,
      packet: packetCopy,
    }, [packetCopy]);
  }

  public destroy(): void {
    this.destroyed = true;
    this.keyInitialized = false;
    for (const w of this.workers) {
      for (const pending of w.pending.values()) {
        pending.reject(new Error('Crypto plane destroyed'));
      }
      w.pending.clear();
      try {
        w.worker.terminate();
      } catch {
        // ignore
      }
    }
    this.workers = [];
    this.sessionKey = null;
    this.randomPrefix = null;
  }

  private ensureWorkers(): void {
    if (this.workers.length > 0) return;
    const size = Math.max(1, Math.min(4, this.poolSize));
    for (let i = 0; i < size; i++) {
      const worker = new Worker(
        new URL('../workers/crypto-plane.worker.ts', import.meta.url),
        { type: 'module' }
      );
      const entry: PoolWorker = {
        worker,
        pending: new Map(),
        ready: false,
        inflight: 0,
      };
      worker.onmessage = (event: MessageEvent<CryptoPlaneOutMessage>) => {
        this.onWorkerMessage(entry, event.data);
      };
      worker.onerror = err => {
        for (const pending of entry.pending.values()) {
          pending.reject(new Error(err.message || 'Crypto worker error'));
        }
        entry.pending.clear();
        entry.ready = false;
      };
      this.workers.push(entry);
    }
  }

  private async initWorkerKey(
    entry: PoolWorker,
    sessionKey: ArrayBuffer,
    randomPrefix: ArrayBuffer
  ): Promise<void> {
    const requestId = this.nextRequestId++;
    await this.request<boolean>(entry, {
      type: 'init-key',
      requestId,
      sessionKey,
      randomPrefix,
    }, [sessionKey, randomPrefix]);
    entry.ready = true;
  }

  private pickWorker(): PoolWorker {
    // Prefer least inflight ready worker.
    let best = this.workers[0];
    for (const w of this.workers) {
      if (!w.ready) continue;
      if (w.inflight < best.inflight) best = w;
    }
    // Round-robin among equal load.
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    const candidate = this.workers[this.nextWorker];
    if (candidate.ready && candidate.inflight <= best.inflight) return candidate;
    return best;
  }

  private request<T extends ArrayBuffer | boolean>(
    entry: PoolWorker,
    message: CryptoPlaneInMessage,
    transfer: Transferable[] = []
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = message.requestId;
      const kind =
        message.type === 'encrypt'
          ? 'encrypt'
          : message.type === 'decrypt'
            ? 'decrypt'
            : message.type === 'reset'
              ? 'reset'
              : 'init';
      entry.pending.set(requestId, {
        resolve: value => resolve(value as T),
        reject,
        kind,
      });
      entry.inflight += 1;
      try {
        entry.worker.postMessage(message, transfer);
      } catch (error) {
        entry.pending.delete(requestId);
        entry.inflight = Math.max(0, entry.inflight - 1);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onWorkerMessage(entry: PoolWorker, msg: CryptoPlaneOutMessage): void {
    const pending = entry.pending.get(msg.requestId);
    if (!pending) return;
    entry.pending.delete(msg.requestId);
    entry.inflight = Math.max(0, entry.inflight - 1);

    if (msg.type === 'error') {
      pending.reject(new Error(msg.message));
      return;
    }
    if (msg.type === 'ready') {
      pending.resolve(true);
      return;
    }
    if (msg.type === 'encrypt-result' || msg.type === 'decrypt-result') {
      pending.resolve(msg.packet);
      return;
    }
    pending.reject(new Error('Unexpected crypto worker response'));
  }
}

let sharedClient: CryptoPlaneClient | null = null;

export function getCryptoPlaneClient(): CryptoPlaneClient {
  if (!sharedClient) sharedClient = new CryptoPlaneClient(2);
  return sharedClient;
}

export function resetCryptoPlaneClient(): void {
  if (sharedClient) {
    sharedClient.destroy();
    sharedClient = null;
  }
}
