/**
 * WASM Core Module Wrapper
 * Rust로 작성된 핵심 연산 모듈을 로드하고 관리합니다.
 * 
 * 포함 기능:
 * - CRC32 체크섬 계산
 * - 패킷 인코딩/디코딩
 * - E2E 암호화 (AES-256-GCM)
 * - 키 유도 (HKDF-SHA256)
 */

import init, {
  calculate_crc32,
  Crc32Hasher,
  PacketEncoder,
  PacketDecoder,
  PacketHeader,
  ChunkPool,
  CryptoSession,
  EncryptedPacketHeader,
  derive_session_key,
  create_key_confirmation,
  verify_key_confirmation,
  is_encrypted_packet,
} from 'pons-core-wasm';

let wasmInitialized = false;
let initPromise: Promise<void> | null = null;

/**
 * WASM 모듈 초기화
 * Worker 또는 메인 스레드에서 한 번만 호출
 */
export async function initWasmCore(): Promise<void> {
  if (wasmInitialized) return;

  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    await init();
    wasmInitialized = true;
    console.log('[WASM] pons-core-wasm initialized (with E2E crypto)');
  })();

  await initPromise;
}

/**
 * WASM 초기화 상태 확인
 */
export function isWasmReady(): boolean {
  return wasmInitialized;
}

// Re-export WASM functions and classes
export {
  // 기존 기능
  calculate_crc32,
  Crc32Hasher,
  PacketEncoder,
  PacketDecoder,
  PacketHeader,
  ChunkPool,
  // E2E 암호화
  CryptoSession,
  EncryptedPacketHeader,
  derive_session_key,
  create_key_confirmation,
  verify_key_confirmation,
  is_encrypted_packet,
};

// Type definitions for better TypeScript support
export interface PacketHeaderData {
  file_index: number;
  chunk_index: number;
  offset: bigint;
  length: number;
  checksum: number;
}

export interface EncryptedPacketHeaderData {
  version: number;
  flags: number;
  file_index: number;
  chunk_index: number;
  offset: bigint;
  plaintext_length: number;
  nonce: Uint8Array;
}

/**
 * PacketHeader를 plain object로 변환
 */
export function headerToObject(header: PacketHeader): PacketHeaderData {
  return {
    file_index: header.file_index,
    chunk_index: header.chunk_index,
    offset: BigInt(header.offset),
    length: header.length,
    checksum: header.checksum,
  };
}

/**
 * EncryptedPacketHeader를 plain object로 변환
 */
export function encryptedHeaderToObject(header: EncryptedPacketHeader): EncryptedPacketHeaderData {
  return {
    version: header.version,
    flags: header.flags,
    file_index: header.file_index,
    chunk_index: header.chunk_index,
    offset: BigInt(header.offset),
    plaintext_length: header.plaintext_length,
    nonce: header.nonce,
  };
}
