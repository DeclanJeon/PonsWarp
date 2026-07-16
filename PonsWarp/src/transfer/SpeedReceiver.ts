import { HEADER_SIZE, SPEED_TRANSFER } from '../utils/constants';

/**
 * Speed-path receiver helpers.
 * Plain packets only; no app decrypt.
 */

export function isPlainSpeedCompatiblePacket(packet: ArrayBuffer): boolean {
  if (!SPEED_TRANSFER) return false;
  if (packet.byteLength < HEADER_SIZE) return false;
  const bytes = new Uint8Array(packet);
  // Encrypted marker
  if (bytes[0] === 0x02 && bytes[1] === 0x01) return false;
  // EOS
  const view = new DataView(packet);
  if (view.getUint16(0, true) === 0xffff) return true;
  const payloadLen = view.getUint32(14, true);
  return packet.byteLength === HEADER_SIZE + payloadLen;
}

export function readPlainPacketMeta(packet: ArrayBuffer): {
  sequence: number;
  offset: number;
  payloadLength: number;
  isEos: boolean;
} | null {
  if (packet.byteLength < HEADER_SIZE) return null;
  const view = new DataView(packet);
  const fileIndex = view.getUint16(0, true);
  if (fileIndex === 0xffff) {
    return { sequence: 0, offset: 0, payloadLength: 0, isEos: true };
  }
  const sequence = view.getUint32(2, true);
  const offset = Number(view.getBigUint64(6, true));
  const payloadLength = view.getUint32(14, true);
  if (packet.byteLength !== HEADER_SIZE + payloadLength) return null;
  return { sequence, offset, payloadLength, isEos: false };
}

/**
 * Fast sequential append gate:
 * if next expected offset matches packet offset, receiver can skip reordering tax.
 */
export function canSequentialAppend(
  nextExpectedOffset: number,
  packetOffset: number
): boolean {
  return nextExpectedOffset === packetOffset;
}
