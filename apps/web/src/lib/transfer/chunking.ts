// Default payload size. Actual send size is clamped to RTCDataChannel.maxMessageSize.
// 64 KiB is the proven cross-device stable size for Chromium DataChannels over WAN/Tailscale.
export const CHUNK_SIZE = 64 * 1024; // 64 KiB payload
// Chromium throws once the RTCDataChannel send queue hits ~16 MiB.
// Keep a conservative high-water mark for multi-device reliability.
export const MAX_BUFFERED_AMOUNT = 2 * 1024 * 1024; // 2 MiB
export const MIN_BUFFERED_AMOUNT = 512 * 1024; // adaptive congestion floor
export const SEND_PROGRESS_INTERVAL_MS = 100; // throttle main-thread progress while blasting chunks
// Multi-DC remains experimental and off by default.
export const DATA_CHANNEL_COUNT = 0;
export const CONTROL_CHANNEL_LABEL = "warp-control";
export const dataChannelLabel = (index: number) => `warp-data-${index}`;
export const WRITE_BATCH_BYTES = 1024 * 1024; // coalesce disk writes to ~1 MiB
export const PROTOCOL_VERSION = 1;

export type BinaryPacketType = 1 | 2 | 3; // chunk | complete | abort

export function encodeChunkHeader(fileIndex: number, chunkIndex: number, totalChunks: number, payloadLength: number): ArrayBuffer {
  const buf = new ArrayBuffer(17);
  const view = new DataView(buf);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, 1); // chunk
  view.setUint16(2, fileIndex, false);
  view.setUint32(4, chunkIndex, false);
  view.setUint32(8, totalChunks, false);
  view.setUint32(12, payloadLength, false);
  view.setUint8(16, 0); // reserved
  return buf;
}

export function concatBuffers(header: ArrayBuffer, payload: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  const payloadBytes =
    payload instanceof ArrayBuffer
      ? new Uint8Array(payload)
      : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  const out = new Uint8Array(header.byteLength + payloadBytes.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(payloadBytes, header.byteLength);
  return out.buffer;
}

export function parseChunkPacket(buffer: ArrayBuffer): {
  version: number;
  type: number;
  fileIndex: number;
  chunkIndex: number;
  totalChunks: number;
  payload: Uint8Array;
} | null {
  if (buffer.byteLength < 17) return null;
  const view = new DataView(buffer);
  const version = view.getUint8(0);
  const type = view.getUint8(1);
  const fileIndex = view.getUint16(2, false);
  const chunkIndex = view.getUint32(4, false);
  const totalChunks = view.getUint32(8, false);
  const payloadLength = view.getUint32(12, false);
  const payload = new Uint8Array(buffer, 17, Math.min(payloadLength, buffer.byteLength - 17));
  return { version, type, fileIndex, chunkIndex, totalChunks, payload };
}

export function totalChunksForSize(size: number, chunkSize = CHUNK_SIZE): number {
  if (size <= 0) return 1;
  return Math.ceil(size / chunkSize);
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256File(file: Blob, chunkSize = 1024 * 1024): Promise<string> {
  // Streaming-ish hash by concatenating chunk digests is not true SHA-256 of whole file.
  // For integrity we hash each file fully in worker when possible; fallback here for small files.
  if (file.size <= 32 * 1024 * 1024) {
    const buf = await file.arrayBuffer();
    return sha256Hex(buf);
  }

  // Large file: rolling digest via SubtleCrypto is not incremental; use per-chunk merkle-like summary.
  const hashes: string[] = [];
  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, offset + chunkSize);
    const buf = await slice.arrayBuffer();
    hashes.push(await sha256Hex(buf));
    offset += chunkSize;
  }
  return sha256Hex(new TextEncoder().encode(hashes.join("")));
}
