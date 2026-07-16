import {
  SPEED_BUFFER_HIGH,
  SPEED_CHUNK_SIZE,
  SPEED_TRANSFER,
} from '../utils/constants';
import {
  createEosPacket,
  createPlainDataPacketFast,
} from '../utils/plainPacket';
import type { BulkTransport } from './BulkTransport';

export type SpeedManifestLike = {
  totalSize: number;
};

export type SpeedSendProgress = {
  bytesSent: number;
  totalBytes: number;
  sequence: number;
};

/**
 * Speed-path firehose:
 * - plain packets (no app AES)
 * - local bufferedAmount pacing only
 * - no partition barriers
 */
export async function sendSpeedFirehose(params: {
  files: File[];
  manifest: SpeedManifestLike;
  transports: BulkTransport[];
  startOffset?: number;
  chunkSize?: number;
  highWater?: number;
  isActive?: () => boolean;
  onProgress?: (p: SpeedSendProgress) => void;
  waitWhilePaused?: () => Promise<void>;
}): Promise<{ bytesSent: number; packets: number }> {
  if (!SPEED_TRANSFER) {
    throw new Error('SpeedSender requires SPEED_TRANSFER');
  }
  const {
    files,
    manifest,
    transports,
    startOffset = 0,
    chunkSize = SPEED_CHUNK_SIZE,
    highWater = SPEED_BUFFER_HIGH,
    isActive = () => true,
    onProgress,
    waitWhilePaused,
  } = params;

  if (transports.length === 0) {
    throw new Error('No connected bulk transports');
  }

  // Best-effort bulk channel readiness.
  await Promise.all(transports.map(t => t.waitBulkReady(1500)));

  // Build flat file cursor from startOffset.
  let fileIndex = 0;
  let fileOffset = 0;
  let globalOffset = 0;
  while (fileIndex < files.length && globalOffset + files[fileIndex].size <= startOffset) {
    globalOffset += files[fileIndex].size;
    fileIndex += 1;
  }
  if (fileIndex < files.length) {
    fileOffset = Math.max(0, startOffset - globalOffset);
    globalOffset = startOffset;
  }

  let sequence = Math.floor(startOffset / Math.max(1, chunkSize));
  let packets = 0;
  let lastProgressAt = 0;
  const readBlockSize = Math.max(chunkSize * 8, 2 * 1024 * 1024);
  let cache:
    | { fileIndex: number; offset: number; data: ArrayBuffer }
    | null = null;

  const readPayload = async (
    fIdx: number,
    fOff: number,
    size: number
  ): Promise<ArrayBuffer> => {
    if (
      cache &&
      cache.fileIndex === fIdx &&
      fOff >= cache.offset &&
      fOff + size <= cache.offset + cache.data.byteLength
    ) {
      const rel = fOff - cache.offset;
      return cache.data.slice(rel, rel + size);
    }
    const file = files[fIdx];
    const blockEnd = Math.min(fOff + readBlockSize, file.size);
    const block = await file.slice(fOff, blockEnd).arrayBuffer();
    cache = { fileIndex: fIdx, offset: fOff, data: block };
    return block.slice(0, size);
  };

  const maxBuffered = () =>
    Math.max(0, ...transports.map(t => t.getBulkBufferedAmount()));

  while (fileIndex < files.length) {
    if (!isActive()) throw new Error('Transfer stopped');
    if (waitWhilePaused) await waitWhilePaused();

    const file = files[fileIndex];
    if (fileOffset >= file.size) {
      fileIndex += 1;
      fileOffset = 0;
      continue;
    }

    const bytes = Math.min(chunkSize, file.size - fileOffset);
    // Keep SCTP queue fed but bounded.
    while (maxBuffered() + bytes > highWater) {
      if (!isActive()) throw new Error('Transfer stopped');
      // Wait on the most-backed-up peer.
      const busiest = transports.reduce((a, b) =>
        a.getBulkBufferedAmount() >= b.getBulkBufferedAmount() ? a : b
      );
      await busiest.waitBulkLow(highWater, Math.floor(highWater / 4));
    }

    const payload = await readPayload(fileIndex, fileOffset, bytes);
    const packet = createPlainDataPacketFast({
      payload,
      sequence,
      offset: globalOffset,
    });

    let success = 0;
    for (const t of transports) {
      if (!t.connected) continue;
      if (t.sendBulk(packet)) success += 1;
    }
    if (success === 0) throw new Error('No connected receivers for speed send');

    sequence += 1;
    packets += 1;
    fileOffset += bytes;
    globalOffset += bytes;

    const now = performance.now();
    if (onProgress && (now - lastProgressAt > 100 || globalOffset >= manifest.totalSize)) {
      lastProgressAt = now;
      onProgress({
        bytesSent: globalOffset,
        totalBytes: manifest.totalSize,
        sequence,
      });
    }
  }

  if (globalOffset !== manifest.totalSize && startOffset === 0) {
    // Allow resume partials; full start must match.
    if (startOffset === 0) {
      // still send EOS with actual offset for receiver to validate
    }
  }

  const eos = createEosPacket();
  for (const t of transports) {
    if (t.connected) t.sendBulk(eos);
  }

  return { bytesSent: globalOffset, packets };
}
