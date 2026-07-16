import type { CandidatePathKind } from './transferFlowControl';

export type ThroughputSample = {
  t: number;
  pathKind: CandidatePathKind;
  protocol: string | null;
  rttMs: number | null;
  availableOutgoingBitrateBps: number | null;
  bulkBufferedAmount: number;
  highWaterBytes: number;
  lowWaterBytes: number;
  chunkSizeBytes: number;
  bulkChannelsArmed: number;
  bytesSent: number;
  bytesReceivedContiguous: number;
  sendMBps: number;
  recvMBps: number;
  checkpointWaits: number;
  pauseCount: number;
  decryptMsEma?: number;
  writeMsEma?: number;
  channelEmptyMs?: number;
};

const DEFAULT_CAPACITY = 240; // ~60s at 250ms

export class ThroughputTrace {
  private samples: ThroughputSample[] = [];
  private readonly capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(8, capacity);
  }

  push(sample: ThroughputSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.capacity) {
      this.samples.splice(0, this.samples.length - this.capacity);
    }
  }

  snapshot(): ThroughputSample[] {
    return this.samples.slice();
  }

  latest(): ThroughputSample | null {
    return this.samples.length > 0
      ? this.samples[this.samples.length - 1]
      : null;
  }

  clear(): void {
    this.samples = [];
  }
}

export const throughputTrace = new ThroughputTrace();
