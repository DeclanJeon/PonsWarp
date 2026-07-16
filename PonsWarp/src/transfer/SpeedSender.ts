import {
  HEADER_SIZE,
  SPEED_BUFFER_HIGH,
  SPEED_CHUNK_SIZE,
  SPEED_TRANSFER,
} from '../utils/constants';

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
  sendPacket: (packet: ArrayBuffer | ArrayBufferView) => number;
  /** Optional drain wait when buffer is high. */
  waitForDrain?: () => Promise<void>;
};

const PREFETCH_LIMIT = 64 * 1024 * 1024;

/**
 * Speed-path firehose:
 * - plain packets (no app AES, CRC skipped)
 * - local bufferedAmount pacing only
 * - optional full-file memory prefetch for small/medium transfers
 * - recycled packet buffer (raw-dc style)
 */
export async function sendSpeedFirehose(params: {
  files: File[];
  manifest: SpeedManifestLike;
  hooks: SpeedSendHooks;
  startOffset?: number;
  /** Exclusive end offset in the flat file concatenation. Defaults to totalSize. */
  endOffset?: number;
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
    endOffset = manifest.totalSize,
    chunkSize = SPEED_CHUNK_SIZE,
    highWater = SPEED_BUFFER_HIGH,
    isActive = () => true,
    onProgress,
    waitWhilePaused,
  } = params;

  if (!files.length) {
    throw new Error('No files for speed firehose');
  }

  const rangeEnd = Math.min(
    manifest.totalSize,
    Math.max(startOffset, endOffset)
  );
  const rangeBytes = Math.max(0, rangeEnd - startOffset);
  if (rangeBytes === 0) {
    return { bytesSent: startOffset, packets: 0 };
  }

  // Prefetch the needed range into one contiguous buffer when small enough.
  // This removes File.slice/arrayBuffer from the send hot loop.
  let flat: Uint8Array | null = null;
  if (rangeBytes <= PREFETCH_LIMIT) {
    flat = new Uint8Array(rangeBytes);
    let writeAt = 0;
    let skip = startOffset;
    for (const file of files) {
      if (writeAt >= rangeBytes) break;
      if (skip >= file.size) {
        skip -= file.size;
        continue;
      }
      const from = skip;
      skip = 0;
      const take = Math.min(file.size - from, rangeBytes - writeAt);
      const part = new Uint8Array(await file.slice(from, from + take).arrayBuffer());
      flat.set(part, writeAt);
      writeAt += part.byteLength;
    }
    if (writeAt !== rangeBytes) {
      // Some test/DOM File shims report size > readable bytes; fall back.
      flat = null;
    }
  }

  // Cursor over files when not prefetched.
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

  // Recycle one packet buffer (header + max chunk).
  let packetBuf = new ArrayBuffer(HEADER_SIZE + chunkSize);
  let packetBytes = new Uint8Array(packetBuf);
  let packetView = new DataView(packetBuf);

  const ensurePacketCapacity = (payloadLen: number) => {
    const need = HEADER_SIZE + payloadLen;
    if (packetBuf.byteLength >= need) return;
    packetBuf = new ArrayBuffer(need);
    packetBytes = new Uint8Array(packetBuf);
    packetView = new DataView(packetBuf);
  };

  const readPayload = async (
    fIdx: number,
    fOff: number,
    size: number
  ): Promise<Uint8Array> => {
    if (
      cache &&
      cache.fileIndex === fIdx &&
      fOff >= cache.offset &&
      fOff + size <= cache.offset + cache.data.byteLength
    ) {
      const rel = fOff - cache.offset;
      return new Uint8Array(cache.data, rel, size);
    }
    const file = files[fIdx];
    const blockEnd = Math.min(fOff + readBlockSize, file.size);
    const block = await file.slice(fOff, blockEnd).arrayBuffer();
    cache = { fileIndex: fIdx, offset: fOff, data: block };
    return new Uint8Array(block, 0, size);
  };

  while (globalOffset < rangeEnd) {
    if (!isActive()) throw new Error('Transfer stopped');
    if (waitWhilePaused) await waitWhilePaused();

    const bytes = Math.min(chunkSize, rangeEnd - globalOffset);
    if (bytes <= 0) break;

    while (hooks.getBufferedAmount() + bytes + HEADER_SIZE > highWater) {
      if (!isActive()) throw new Error('Transfer stopped');
      if (hooks.waitForDrain) {
        await hooks.waitForDrain();
      } else {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 4);
        await promise;
      }
    }

    let payload: Uint8Array;
    if (flat) {
      const rel = globalOffset - startOffset;
      payload = flat.subarray(rel, rel + bytes);
    } else {
      // Advance file cursor if needed.
      while (fileIndex < files.length && fileOffset >= files[fileIndex].size) {
        fileIndex += 1;
        fileOffset = 0;
      }
      if (fileIndex >= files.length) {
        throw new Error('File cursor past end during speed send');
      }
      const room = files[fileIndex].size - fileOffset;
      const take = Math.min(bytes, room);
      payload = await readPayload(fileIndex, fileOffset, take);
      // If file boundary splits chunk, only send this file's remainder this iteration.
      if (take < bytes) {
        // fall through with take
      }
      fileOffset += payload.byteLength;
    }

    const payloadLen = payload.byteLength;
    ensurePacketCapacity(payloadLen);
    // Plain fast header: fileId=0, seq, offset, len, crc=0
    packetView.setUint16(0, 0, true);
    packetView.setUint32(2, sequence, true);
    packetView.setBigUint64(6, BigInt(globalOffset), true);
    packetView.setUint32(14, payloadLen, true);
    packetView.setUint32(18, 0, true);
    packetBytes.set(payload, HEADER_SIZE);

    // Zero-copy view into recycled buffer (DataChannel accepts BufferSource).
    const packet = packetBytes.subarray(0, HEADER_SIZE + payloadLen);

    let success = hooks.sendPacket(packet as unknown as ArrayBuffer);
    if (success === 0) {
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
    globalOffset += payloadLen;

    // Rare yield so UI/CDP can run without starving the fill loop.
    if ((packets & 63) === 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      queueMicrotask(resolve);
      await promise;
    }

    const now = performance.now();
    if (
      onProgress &&
      (now - lastProgressAt > 100 || globalOffset >= rangeEnd)
    ) {
      lastProgressAt = now;
      onProgress({
        bytesSent: globalOffset,
        totalBytes: manifest.totalSize,
        sequence,
      });
    }
  }

  return { bytesSent: globalOffset, packets };
}
