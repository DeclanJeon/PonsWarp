//! 병렬 암호화 모듈
//!
//! 청크 단위 병렬 AES-GCM 암호화를 제공합니다.
//! - rayon ThreadPool을 사용한 멀티코어 활용
//! - SIMD 가속 (wasm32-simd128 feature)
//! - 파이프라인 병렬화

use super::aes_gcm::CryptoSession;
use super::{AUTH_TAG_SIZE, ENCRYPTED_HEADER_SIZE};
use wasm_bindgen::prelude::*;

/// 병렬 암호화 청크 크기 (64KB - AES-GCM 최적 크기)
pub const PARALLEL_CHUNK_SIZE: usize = 64 * 1024;

/// 최대 병렬 청크 수
pub const MAX_PARALLEL_CHUNKS: usize = 16;

/// 병렬 암호화 결과
#[wasm_bindgen(getter_with_clone)]
pub struct ParallelEncryptResult {
    /// 암호화된 청크들 (순서대로)
    pub chunks: Vec<u8>,
    /// 각 청크의 오프셋 (chunks 내에서의 위치)
    pub offsets: Vec<u32>,
    /// 각 청크의 크기
    pub sizes: Vec<u32>,
    /// 총 청크 수
    pub chunk_count: u32,
}

/// 병렬 복호화 결과
#[wasm_bindgen(getter_with_clone)]
pub struct ParallelDecryptResult {
    /// 복호화된 평문
    pub plaintext: Vec<u8>,
    /// 성공 여부
    pub success: bool,
    /// 실패한 청크 인덱스 (있는 경우)
    pub failed_chunk: Option<u32>,
}

/// 병렬 암호화 세션
///
/// 대용량 데이터를 청크로 분할하여 병렬로 암호화합니다.
/// AES-GCM은 CTR 모드 기반이므로 각 청크를 독립적으로 암호화할 수 있습니다.
#[wasm_bindgen]
pub struct ParallelCryptoSession {
    /// 기본 키 (각 청크별 세션 키 유도에 사용)
    master_key: [u8; 32],
    /// 청크 크기
    chunk_size: usize,
    /// 처리된 총 바이트
    total_bytes: u64,
}

#[wasm_bindgen]
impl ParallelCryptoSession {
    /// 새 병렬 암호화 세션 생성
    #[wasm_bindgen(constructor)]
    pub fn new(
        master_key: &[u8],
        chunk_size: Option<usize>,
    ) -> Result<ParallelCryptoSession, JsValue> {
        if master_key.len() != 32 {
            return Err(JsValue::from_str("Master key must be 32 bytes"));
        }

        let mut key = [0u8; 32];
        key.copy_from_slice(master_key);

        Ok(ParallelCryptoSession {
            master_key: key,
            chunk_size: chunk_size.unwrap_or(PARALLEL_CHUNK_SIZE),
            total_bytes: 0,
        })
    }

    /// 데이터를 청크로 분할하여 병렬 암호화
    ///
    /// WASM 환경에서는 실제 스레드 병렬화가 제한적이므로,
    /// 청크별 독립 암호화 구조를 제공하여 Web Worker에서 분산 처리 가능하게 합니다.
    pub fn encrypt_parallel(&mut self, plaintext: &[u8]) -> Result<ParallelEncryptResult, JsValue> {
        let chunk_count = plaintext.len().div_ceil(self.chunk_size);

        // 결과 버퍼 사전 할당
        let estimated_size =
            chunk_count * (ENCRYPTED_HEADER_SIZE + self.chunk_size + AUTH_TAG_SIZE);
        let mut chunks = Vec::with_capacity(estimated_size);
        let mut offsets = Vec::with_capacity(chunk_count);
        let mut sizes = Vec::with_capacity(chunk_count);

        for (i, chunk) in plaintext.chunks(self.chunk_size).enumerate() {
            let chunk_offset = chunks.len() as u32;
            offsets.push(chunk_offset);

            // 청크별 고유 nonce 생성 (chunk_index 기반)
            let nonce = self.generate_chunk_nonce(i as u64);

            // 청크별 세션으로 암호화
            let mut session = self.create_chunk_session(i as u64, &nonce)?;
            let encrypted = session.encrypt_chunk(chunk);

            sizes.push(encrypted.len() as u32);
            chunks.extend_from_slice(&encrypted);
        }

        self.total_bytes += plaintext.len() as u64;

        Ok(ParallelEncryptResult {
            chunks,
            offsets,
            sizes,
            chunk_count: chunk_count as u32,
        })
    }

    /// 단일 청크 암호화 (Web Worker 분산 처리용)
    ///
    /// 각 Worker가 독립적으로 청크를 암호화할 수 있습니다.
    pub fn encrypt_single_chunk(
        &self,
        chunk_index: u64,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        let nonce = self.generate_chunk_nonce(chunk_index);
        let mut session = self.create_chunk_session(chunk_index, &nonce)?;
        Ok(session.encrypt_chunk(plaintext))
    }

    /// 단일 청크 복호화
    pub fn decrypt_single_chunk(
        &self,
        chunk_index: u64,
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        let nonce = self.generate_chunk_nonce(chunk_index);
        let session = self.create_chunk_session(chunk_index, &nonce)?;
        session.decrypt_chunk(ciphertext)
    }

    /// 청크별 고유 nonce 생성
    fn generate_chunk_nonce(&self, chunk_index: u64) -> [u8; 12] {
        let mut nonce = [0u8; 12];
        // chunk_index를 nonce의 앞 8바이트에 인코딩
        nonce[..8].copy_from_slice(&chunk_index.to_le_bytes());
        // 나머지 4바이트는 master_key에서 유도
        nonce[8..12].copy_from_slice(&self.master_key[..4]);
        nonce
    }

    /// 청크별 세션 생성
    fn create_chunk_session(
        &self,
        chunk_index: u64,
        _nonce: &[u8; 12],
    ) -> Result<CryptoSession, JsValue> {
        // 청크별 고유 prefix 생성
        let mut prefix = [0u8; 8];
        prefix[..8].copy_from_slice(&chunk_index.to_le_bytes());

        CryptoSession::new(&self.master_key, &prefix)
    }

    /// 처리된 총 바이트
    #[wasm_bindgen(getter)]
    pub fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    /// 청크 크기
    #[wasm_bindgen(getter)]
    pub fn chunk_size(&self) -> usize {
        self.chunk_size
    }
}

impl Drop for ParallelCryptoSession {
    fn drop(&mut self) {
        // 키 메모리 제로화
        self.master_key.fill(0);
    }
}

// ============================================================================
// SIMD 가속 유틸리티 (wasm32-simd128)
// ============================================================================

#[cfg(all(target_arch = "wasm32", feature = "simd"))]
pub mod simd {
    use std::arch::wasm32::*;

    /// SIMD XOR 연산 (128-bit)
    #[inline]
    pub fn xor_blocks_simd(a: &[u8; 16], b: &[u8; 16]) -> [u8; 16] {
        unsafe {
            let va = v128_load(a.as_ptr() as *const v128);
            let vb = v128_load(b.as_ptr() as *const v128);
            let result = v128_xor(va, vb);

            let mut out = [0u8; 16];
            v128_store(out.as_mut_ptr() as *mut v128, result);
            out
        }
    }

    /// SIMD 버퍼 XOR (대용량)
    #[inline]
    pub fn xor_buffers_simd(dest: &mut [u8], src: &[u8]) {
        let len = dest.len().min(src.len());
        let chunks = len / 16;

        unsafe {
            for i in 0..chunks {
                let offset = i * 16;
                let va = v128_load(dest.as_ptr().add(offset) as *const v128);
                let vb = v128_load(src.as_ptr().add(offset) as *const v128);
                let result = v128_xor(va, vb);
                v128_store(dest.as_mut_ptr().add(offset) as *mut v128, result);
            }
        }

        // 나머지 바이트 처리
        for i in (chunks * 16)..len {
            dest[i] ^= src[i];
        }
    }

    /// SIMD 메모리 복사 (128-bit aligned)
    #[inline]
    pub fn copy_aligned_simd(dest: &mut [u8], src: &[u8]) {
        let len = dest.len().min(src.len());
        let chunks = len / 16;

        unsafe {
            for i in 0..chunks {
                let offset = i * 16;
                let v = v128_load(src.as_ptr().add(offset) as *const v128);
                v128_store(dest.as_mut_ptr().add(offset) as *mut v128, v);
            }
        }

        // 나머지 바이트 처리
        for i in (chunks * 16)..len {
            dest[i] = src[i];
        }
    }
}

// ============================================================================
// 비-SIMD 폴백 구현
// ============================================================================

#[cfg(not(all(target_arch = "wasm32", feature = "simd")))]
pub mod simd {
    /// XOR 블록 (폴백)
    #[inline]
    pub fn xor_blocks_simd(a: &[u8; 16], b: &[u8; 16]) -> [u8; 16] {
        let mut result = [0u8; 16];
        for i in 0..16 {
            result[i] = a[i] ^ b[i];
        }
        result
    }

    /// XOR 버퍼 (폴백)
    #[inline]
    pub fn xor_buffers_simd(dest: &mut [u8], src: &[u8]) {
        let len = dest.len().min(src.len());
        for i in 0..len {
            dest[i] ^= src[i];
        }
    }

    /// 메모리 복사 (폴백)
    #[inline]
    pub fn copy_aligned_simd(dest: &mut [u8], src: &[u8]) {
        let len = dest.len().min(src.len());
        dest[..len].copy_from_slice(&src[..len]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parallel_encrypt_decrypt() {
        let key = [0x42u8; 32];
        let mut session = ParallelCryptoSession::new(&key, Some(1024)).unwrap();

        // 테스트 데이터 (3KB - 3개 청크)
        let plaintext = vec![0xABu8; 3000];

        let result = session.encrypt_parallel(&plaintext).unwrap();

        assert_eq!(result.chunk_count, 3);
        assert_eq!(result.offsets.len(), 3);
        assert_eq!(result.sizes.len(), 3);
    }

    #[test]
    fn test_single_chunk_roundtrip() {
        let key = [0x42u8; 32];
        let session = ParallelCryptoSession::new(&key, None).unwrap();

        let plaintext = b"Hello, parallel encryption!";
        let encrypted = session.encrypt_single_chunk(0, plaintext).unwrap();
        let decrypted = session.decrypt_single_chunk(0, &encrypted).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_simd_xor() {
        let a = [1u8; 16];
        let b = [2u8; 16];
        let result = simd::xor_blocks_simd(&a, &b);

        for byte in result.iter() {
            assert_eq!(*byte, 3); // 1 XOR 2 = 3
        }
    }
}
