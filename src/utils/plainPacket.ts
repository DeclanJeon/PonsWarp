import { HEADER_SIZE } from './constants';

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

export function calculateCRC32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createPlainDataPacket(params: {
  payload: ArrayBuffer | Uint8Array;
  sequence: number;
  offset: number;
}): ArrayBuffer {
  const payload =
    params.payload instanceof Uint8Array
      ? params.payload
      : new Uint8Array(params.payload);
  const packet = new ArrayBuffer(HEADER_SIZE + payload.byteLength);
  const view = new DataView(packet);
  const bytes = new Uint8Array(packet);

  view.setUint16(0, 0, true);
  view.setUint32(2, params.sequence, true);
  view.setBigUint64(6, BigInt(params.offset), true);
  view.setUint32(14, payload.byteLength, true);
  view.setUint32(18, calculateCRC32(payload), true);
  bytes.set(payload, HEADER_SIZE);

  return packet;
}

export function createEosPacket(): ArrayBuffer {
  const packet = new ArrayBuffer(HEADER_SIZE);
  new DataView(packet).setUint16(0, 0xffff, true);
  return packet;
}
