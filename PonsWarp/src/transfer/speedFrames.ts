/**
 * Speed-path bulk frames (docs/design/speed-first-file-transfer-redesign.md)
 * Plain DTLS bulk only — no app AES.
 */

export const SPEED_FRAME_MAGIC = 0xa1;
export const SPEED_FLAG_EOS = 1 << 0;
export const SPEED_FLAG_HAS_FILE_INDEX = 1 << 2;

export type SpeedFrame = {
  seq: number;
  offset: number;
  payload: Uint8Array;
  fileIndex?: number;
  eos?: boolean;
};

export function encodeSpeedFrame(frame: SpeedFrame): ArrayBuffer {
  const hasFileIndex =
    typeof frame.fileIndex === 'number' && Number.isFinite(frame.fileIndex);
  const flags =
    (frame.eos ? SPEED_FLAG_EOS : 0) |
    (hasFileIndex ? SPEED_FLAG_HAS_FILE_INDEX : 0);
  const headerSize = 1 + 1 + 4 + 8 + 4 + (hasFileIndex ? 2 : 0);
  const packet = new ArrayBuffer(headerSize + frame.payload.byteLength);
  const view = new DataView(packet);
  const bytes = new Uint8Array(packet);
  let o = 0;
  view.setUint8(o, SPEED_FRAME_MAGIC);
  o += 1;
  view.setUint8(o, flags);
  o += 1;
  view.setUint32(o, frame.seq >>> 0, true);
  o += 4;
  view.setBigUint64(o, BigInt(frame.offset), true);
  o += 8;
  view.setUint32(o, frame.payload.byteLength >>> 0, true);
  o += 4;
  if (hasFileIndex) {
    view.setUint16(o, frame.fileIndex as number, true);
    o += 2;
  }
  bytes.set(frame.payload, o);
  return packet;
}

export function decodeSpeedFrame(packet: ArrayBuffer): SpeedFrame | null {
  if (packet.byteLength < 1 + 1 + 4 + 8 + 4) return null;
  const view = new DataView(packet);
  if (view.getUint8(0) !== SPEED_FRAME_MAGIC) return null;
  const flags = view.getUint8(1);
  const seq = view.getUint32(2, true);
  const offset = Number(view.getBigUint64(6, true));
  const payloadLen = view.getUint32(14, true);
  let o = 18;
  let fileIndex: number | undefined;
  if (flags & SPEED_FLAG_HAS_FILE_INDEX) {
    if (packet.byteLength < o + 2 + payloadLen) return null;
    fileIndex = view.getUint16(o, true);
    o += 2;
  }
  if (packet.byteLength < o + payloadLen) return null;
  const payload = new Uint8Array(packet, o, payloadLen);
  return {
    seq,
    offset,
    payload,
    fileIndex,
    eos: Boolean(flags & SPEED_FLAG_EOS),
  };
}

export function isSpeedFrame(packet: ArrayBuffer): boolean {
  return packet.byteLength > 0 && new Uint8Array(packet)[0] === SPEED_FRAME_MAGIC;
}
