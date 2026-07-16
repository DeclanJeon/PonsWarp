import type { SinglePeerConnection } from '../services/singlePeerConnection';
import {
  SPEED_BUFFER_HIGH,
  SPEED_BUFFER_LOW,
} from '../utils/constants';

/**
 * Thin bulk/control facade over SinglePeerConnection for the speed path.
 * Control = JSON strings on default channel semantics.
 * Bulk = sendBulk() (unordered reliable when bulk plane is available).
 */
export class BulkTransport {
  constructor(private readonly peer: SinglePeerConnection) {}

  public get id(): string {
    return this.peer.id;
  }

  public get connected(): boolean {
    return this.peer.connected && !this.peer.isDestroyed();
  }

  public sendControl(message: object): boolean {
    return this.peer.send(JSON.stringify(message));
  }

  public sendBulk(packet: ArrayBuffer): boolean {
    return this.peer.sendBulk(packet);
  }

  public getBulkBufferedAmount(): number {
    return this.peer.getBufferedAmount();
  }

  public hasBulkChannel(): boolean {
    return this.peer.hasBulkChannel();
  }

  public async waitBulkReady(timeoutMs = 1500): Promise<boolean> {
    if (typeof this.peer.waitForBulkReady === 'function') {
      return this.peer.waitForBulkReady(timeoutMs);
    }
    return this.hasBulkChannel();
  }

  public async waitBulkLow(
    high = SPEED_BUFFER_HIGH,
    low = SPEED_BUFFER_LOW
  ): Promise<void> {
    if (this.getBulkBufferedAmount() <= low) return;

    const { promise, resolve } = Promise.withResolvers<void>();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      this.peer.off('drain', onDrain);
      resolve();
    };
    const onDrain = () => {
      if (this.getBulkBufferedAmount() <= high) done();
    };
    this.peer.on('drain', onDrain);
    const timer = setInterval(() => {
      if (!this.connected) {
        done();
        return;
      }
      if (this.getBulkBufferedAmount() <= high) done();
    }, 4);
    // Immediate re-check after attaching listener.
    onDrain();
    await promise;
  }
}

export function createBulkTransports(
  peers: SinglePeerConnection[]
): BulkTransport[] {
  return peers.filter(p => p.connected && !p.isDestroyed()).map(p => new BulkTransport(p));
}
