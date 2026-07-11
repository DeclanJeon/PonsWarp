/**
 * 🚀 CRC32 Checksum Utility
 * 데이터 무결성 검증을 위한 고성능 CRC32 구현
 */

const CRC_TABLE = new Int32Array(256);

// CRC 테이블 초기화 (한 번만 실행)
(function initCrcTable() {
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC_TABLE[i] = c;
  }
})();

export function calculateCRC32(data: Uint8Array): number {
  let crc = -1; // 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0; // 부호 없는 정수로 변환
}
