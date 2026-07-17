//! PonsWarp E2E 암호화 모듈
//!
//! AES-256-GCM 기반 종단간 암호화를 제공합니다.
//! - 키 유도: HKDF-SHA256
//! - 암호화: AES-256-GCM (AEAD)
//! - Nonce: 12 bytes (counter + random)
//! - 병렬 암호화: 청크 단위 독립 암호화 (Web Worker 분산 처리)
//! - SIMD 가속: wasm32-simd128 지원

mod aes_gcm;
mod kdf;
mod parallel;

pub use aes_gcm::*;
pub use kdf::*;
pub use parallel::*;

use wasm_bindgen::prelude::*;

/// 암호화 버전 상수
pub const CRYPTO_VERSION: u8 = 0x02;

/// 암호화 플래그
pub mod flags {
    pub const ENCRYPTED: u8 = 0b0000_0001;
    pub const COMPRESSED: u8 = 0b0000_0010;
}

/// 암호화된 패킷 헤더 크기 (38 bytes)
pub const ENCRYPTED_HEADER_SIZE: usize = 38;

/// AES-GCM Auth Tag 크기 (16 bytes)
pub const AUTH_TAG_SIZE: usize = 16;

/// Nonce 크기 (12 bytes)
pub const NONCE_SIZE: usize = 12;

/// 암호화된 패킷 헤더
#[wasm_bindgen(getter_with_clone)]
pub struct EncryptedPacketHeader {
    pub version: u8,
    pub flags: u8,
    pub file_index: u16,
    pub chunk_index: u32,
    pub offset: u64,
    pub plaintext_length: u32,
    pub nonce: Vec<u8>,
}

#[wasm_bindgen]
impl EncryptedPacketHeader {
    /// 헤더를 바이트로 직렬화
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = vec![0u8; ENCRYPTED_HEADER_SIZE];

        bytes[0] = self.version;
        bytes[1] = self.flags;
        bytes[2..4].copy_from_slice(&self.file_index.to_le_bytes());
        bytes[4..8].copy_from_slice(&self.chunk_index.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.offset.to_le_bytes());
        bytes[16..20].copy_from_slice(&self.plaintext_length.to_le_bytes());
        bytes[20..32].copy_from_slice(&self.nonce[..NONCE_SIZE]);
        // [32..36] reserved

        bytes
    }

    /// 바이트에서 헤더 파싱
    pub fn from_bytes(data: &[u8]) -> Option<EncryptedPacketHeader> {
        if data.len() < ENCRYPTED_HEADER_SIZE {
            return None;
        }

        let version = data[0];
        if version != CRYPTO_VERSION {
            return None;
        }

        Some(EncryptedPacketHeader {
            version,
            flags: data[1],
            file_index: u16::from_le_bytes([data[2], data[3]]),
            chunk_index: u32::from_le_bytes([data[4], data[5], data[6], data[7]]),
            offset: u64::from_le_bytes([
                data[8], data[9], data[10], data[11], data[12], data[13], data[14], data[15],
            ]),
            plaintext_length: u32::from_le_bytes([data[16], data[17], data[18], data[19]]),
            nonce: data[20..32].to_vec(),
        })
    }

    /// 암호화 여부 확인
    pub fn is_encrypted(&self) -> bool {
        self.flags & flags::ENCRYPTED != 0
    }

    /// 압축 여부 확인
    pub fn is_compressed(&self) -> bool {
        self.flags & flags::COMPRESSED != 0
    }
}

/// 패킷이 암호화된 버전인지 확인
#[wasm_bindgen]
pub fn is_encrypted_packet(data: &[u8]) -> bool {
    if data.is_empty() {
        return false;
    }
    data[0] == CRYPTO_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_header_roundtrip() {
        let header = EncryptedPacketHeader {
            version: CRYPTO_VERSION,
            flags: flags::ENCRYPTED,
            file_index: 1,
            chunk_index: 42,
            offset: 1024,
            plaintext_length: 65536,
            nonce: vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        };

        let bytes = header.to_bytes();
        let parsed = EncryptedPacketHeader::from_bytes(&bytes).unwrap();

        assert_eq!(parsed.version, CRYPTO_VERSION);
        assert_eq!(parsed.flags, flags::ENCRYPTED);
        assert_eq!(parsed.file_index, 1);
        assert_eq!(parsed.chunk_index, 42);
        assert_eq!(parsed.offset, 1024);
        assert_eq!(parsed.plaintext_length, 65536);
        assert!(parsed.is_encrypted());
        assert!(!parsed.is_compressed());
    }
}
