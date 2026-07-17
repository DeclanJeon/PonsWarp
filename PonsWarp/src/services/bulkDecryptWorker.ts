/**
 * Main-thread facade over bulk-decrypt.worker.
 * Keeps AES-GCM decrypt off the UI/receiver main thread.
 */
import { logWarn } from '../utils/logger';

type Pending = {
  resolve: (packet: ArrayBuffer) => void;
  reject: (error: Error) => void;
};

export class BulkDecryptWorker {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready = false;
  private failed: Error | null = null;

  static isSupported(): boolean {
    return typeof Worker !== 'undefined';
  }

  async start(sessionKey: Uint8Array): Promise<void> {
    this.close();
    this.failed = null;
    this.ready = false;
    this.pending.clear();
    this.nextId = 1;

    this.worker = new Worker(
      new URL('../workers/bulk-decrypt.worker.ts', import.meta.url),
      { type: 'module' }
    );

    await new Promise<void>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Decrypt worker missing'));
        return;
      }

      const onMessage = (event: MessageEvent) => {
        const data = event.data;
        if (data?.type === 'ready') {
          cleanup();
          this.ready = true;
          resolve();
          return;
        }
        if (data?.type === 'error' && data.id == null) {
          cleanup();
          reject(new Error(data.message || 'Decrypt worker init failed'));
        }
      };
      const onError = (event: ErrorEvent) => {
        cleanup();
        reject(new Error(event.message || 'Decrypt worker failed'));
      };
      const cleanup = () => {
        this.worker?.removeEventListener('message', onMessage as EventListener);
        this.worker?.removeEventListener('error', onError);
      };

      this.worker.addEventListener('message', onMessage as EventListener);
      this.worker.addEventListener('error', onError);

      const keyCopy = new Uint8Array(sessionKey.byteLength);
      keyCopy.set(sessionKey);
      this.worker.postMessage({
        type: 'init',
        payload: { sessionKey: keyCopy.buffer },
      });
    });

    // ongoing message handler
    this.worker.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === 'decrypted') {
        const p = this.pending.get(data.id);
        if (!p) return;
        this.pending.delete(data.id);
        p.resolve(data.packet);
        return;
      }
      if (data?.type === 'error') {
        const p = data.id != null ? this.pending.get(data.id) : null;
        const err = new Error(data.message || 'Decrypt failed');
        if (p) {
          this.pending.delete(data.id);
          p.reject(err);
        } else {
          this.failed = err;
        }
      }
    };
    this.worker.onerror = (event: ErrorEvent) => {
      this.failed = new Error(event.message || 'Decrypt worker crashed');
      for (const [, p] of this.pending) {
        p.reject(this.failed);
      }
      this.pending.clear();
    };
  }

  decrypt(packet: ArrayBuffer): Promise<ArrayBuffer> {
    if (this.failed) return Promise.reject(this.failed);
    if (!this.worker || !this.ready) {
      return Promise.reject(new Error('Decrypt worker not ready'));
    }
    const id = this.nextId++;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Transfer packet ownership to worker (caller must not use it after).
      this.worker!.postMessage(
        { type: 'decrypt', payload: { id, packet } },
        [packet]
      );
    });
  }

  close(): void {
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'close' });
      } catch {
        // ignore
      }
      try {
        this.worker.terminate();
      } catch {
        // ignore
      }
    }
    this.worker = null;
    this.ready = false;
    for (const [, p] of this.pending) {
      p.reject(new Error('Decrypt worker closed'));
    }
    this.pending.clear();
  }
}

export function tryCreateBulkDecryptWorker(): BulkDecryptWorker | null {
  if (!BulkDecryptWorker.isSupported()) return null;
  try {
    return new BulkDecryptWorker();
  } catch (error) {
    logWarn('[BulkDecryptWorker]', 'Unavailable', error);
    return null;
  }
}
