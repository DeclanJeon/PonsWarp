import {
  SPEED_BUFFER_HIGH,
  SPEED_CHUNK_SIZE,
  SPEED_TRANSFER,
} from '../utils/constants';
import {
  createEosPacket,
  createPlainDataPacketFast,
} from '../utils/plainPacket';

export type SpeedManifestLike = {
  totalSize: number;
};

export type SpeedSendProgress = {
  bytesSent: number;
  totalBytes: number;
  sequence: number;
};

export type SpeedSendHooks = {
  /** Return current max peer bufferedAmount. */
  getBufferedAmount: () => number;
  /** Send one packet to all active peers; return success count. */
  sendPacket: (packet: ArrayBuffer) => number;
  /** Optional drain wait when buffer is high. */
  waitForDrain?: () => Promise<void>;
};

/**
 * Speed-path firehose using the existing peer send path (broadcastChunk).
 * - plain packets (no app AES)
 * - local bufferedAmount pacing only
 * - no partition barriers
 */
export async function sendSpeedFirehose(params: {
  files: File[];
  manifest: SpeedManifestLike;
  hooks: SpeedSendHooks;
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
    hooks,
    startOffset = 0,
    chunkSize = SPEED_CHUNK_SIZE,
    highWater = SPEED_BUFFER_HIGH,
    isActive = () => true,
    onProgress,
    waitWhilePaused,
  } = params;

  if (!files.length) {
    throw new Error('No files for speed firehose');
  }

  // Build flat file cursor from startOffset.
  let fileIndex = 0;
  let fileOffset = 0;
  let globalOffset = 0;
  while (
    fileIndex < files.length &&
    globalOffset + files[fileIndex].size <= startOffset
  ) {
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
  const readBlockSize = Math.max(chunkSize * 16, 4 * 1024 * 1024);
  let cache: { fileIndex: number; offset: number; data: ArrayBuffer } | null =
    null;

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
    while (hooks.getBufferedAmount() + bytes > highWater) {
      if (!isActive()) throw new Error('Transfer stopped');
      if (hooks.waitForDrain) {
        await hooks.waitForDrain();
      } else {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 4);
        await promise;
      }
    }

    const payload = await readPayload(fileIndex, fileOffset, bytes);
    const packet = createPlainDataPacketFast({
      payload,
      sequence,
      offset: globalOffset,
    });

    let success = hooks.sendPacket(packet);
    if (success === 0) {
      // brief retry for channel open races
      for (let attempt = 0; attempt < 5 && success === 0; attempt++) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 8);
        await promise;
        success = hooks.sendPacket(packet);
      }
    }
    if (success === 0) throw new Error('No connected receivers for speed send');

    sequence += 1;
    packets += 1;
    fileOffset += bytes;
    globalOffset += bytes;

    // Yield every 32 packets (~7.5MB @240KB) so WebRTC can drain without killing fill rate.
    if ((packets & 31) === 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      queueMicrotask(resolve);
      await promise;
    }

    const now = performance.now();
    if (
      onProgress &&
      (now - lastProgressAt > 100 || globalOffset >= manifest.totalSize)
    ) {
      lastProgressAt = now;
      onProgress({
        bytesSent: globalOffset,
        totalBytes: manifest.totalSize,
        sequence,
      });
    }
  }

  // EOS is sent by finishTransfer(); avoid double-EOS races.
  return { bytesSent: globalOffset, packets };
}
