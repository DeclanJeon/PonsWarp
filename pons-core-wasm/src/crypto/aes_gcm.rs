//! AES-256-GCM 암호화 모듈
//!
//! 청크 단위 암호화/복호화를 제공합니다.
//! - 키 크기: 256 bits
//! - Nonce: 96 bits (12 bytes)
//! - Auth Tag: 128 bits (16 bytes)

use super::{
    flags, EncryptedPacketHeader, AUTH_TAG_SIZE, CRYPTO_VERSION, ENCRYPTED_HEADER_SIZE, NONCE_SIZE,
};
use wasm_bindgen::prelude::*;

/// AES 블록 크기
const AES_BLOCK_SIZE: usize = 16;

/// AES-256 키 크기
const AES_KEY_SIZE: usize = 32;

/// AES S-Box
const SBOX: [u8; 256] = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];

/// AES Round Constants
const RCON: [u8; 11] = [
    0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36,
];

/// GF(2^128) 곱셈용 테이블 (GHASH)
fn gf_mult(x: u128, y: u128) -> u128 {
    let mut z: u128 = 0;
    let mut v = y;

    for i in 0..128 {
        if (x >> (127 - i)) & 1 == 1 {
            z ^= v;
        }
        let carry = v & 1;
        v >>= 1;
        if carry == 1 {
            v ^= 0xe1 << 120; // R = 11100001 || 0^120
        }
    }
    z
}

/// AES 키 확장
fn aes_key_expansion(key: &[u8; AES_KEY_SIZE]) -> [[u8; 16]; 15] {
    let mut round_keys = [[0u8; 16]; 15];
    let nk = 8; // AES-256: 8 words
    let nr = 14; // AES-256: 14 rounds

    // 첫 8 words는 원본 키
    for i in 0..nk {
        for j in 0..4 {
            round_keys[i / 4][(i % 4) * 4 + j] = key[i * 4 + j];
        }
    }

    let mut temp = [0u8; 4];
    for i in nk..(4 * (nr + 1)) {
        let prev_word_idx = i - 1;
        let prev_key_idx = prev_word_idx / 4;
        let prev_word_offset = (prev_word_idx % 4) * 4;

        temp.copy_from_slice(&round_keys[prev_key_idx][prev_word_offset..prev_word_offset + 4]);

        if i % nk == 0 {
            // RotWord + SubWord + Rcon
            let t = temp[0];
            temp[0] = SBOX[temp[1] as usize] ^ RCON[i / nk];
            temp[1] = SBOX[temp[2] as usize];
            temp[2] = SBOX[temp[3] as usize];
            temp[3] = SBOX[t as usize];
        } else if i % nk == 4 {
            // SubWord only
            for j in 0..4 {
                temp[j] = SBOX[temp[j] as usize];
            }
        }

        let nk_back_idx = i - nk;
        let nk_back_key_idx = nk_back_idx / 4;
        let nk_back_offset = (nk_back_idx % 4) * 4;

        let curr_key_idx = i / 4;
        let curr_offset = (i % 4) * 4;

        for j in 0..4 {
            round_keys[curr_key_idx][curr_offset + j] =
                round_keys[nk_back_key_idx][nk_back_offset + j] ^ temp[j];
        }
    }

    round_keys
}

/// AES 단일 블록 암호화
fn aes_encrypt_block(block: &[u8; 16], round_keys: &[[u8; 16]; 15]) -> [u8; 16] {
    let mut state = *block;

    // Initial round key addition
    for i in 0..16 {
        state[i] ^= round_keys[0][i];
    }

    // Main rounds
    for round_key in round_keys.iter().take(14).skip(1) {
        // SubBytes
        for i in 0..16 {
            state[i] = SBOX[state[i] as usize];
        }

        // ShiftRows
        let tmp = state[1];
        state[1] = state[5];
        state[5] = state[9];
        state[9] = state[13];
        state[13] = tmp;

        state.swap(2, 10);
        state.swap(6, 14);

        let tmp = state[3];
        state[3] = state[15];
        state[15] = state[11];
        state[11] = state[7];
        state[7] = tmp;

        // MixColumns
        for col in 0..4 {
            let i = col * 4;
            let a = state[i];
            let b = state[i + 1];
            let c = state[i + 2];
            let d = state[i + 3];

            let xtime = |x: u8| -> u8 {
                if x & 0x80 != 0 {
                    (x << 1) ^ 0x1b
                } else {
                    x << 1
                }
            };

            state[i] = xtime(a) ^ xtime(b) ^ b ^ c ^ d;
            state[i + 1] = a ^ xtime(b) ^ xtime(c) ^ c ^ d;
            state[i + 2] = a ^ b ^ xtime(c) ^ xtime(d) ^ d;
            state[i + 3] = xtime(a) ^ a ^ b ^ c ^ xtime(d);
        }

        // AddRoundKey
        for i in 0..16 {
            state[i] ^= round_key[i];
        }
    }

    // Final round (no MixColumns)
    for i in 0..16 {
        state[i] = SBOX[state[i] as usize];
    }

    let tmp = state[1];
    state[1] = state[5];
    state[5] = state[9];
    state[9] = state[13];
    state[13] = tmp;

    state.swap(2, 10);
    state.swap(6, 14);

    let tmp = state[3];
    state[3] = state[15];
    state[15] = state[11];
    state[11] = state[7];
    state[7] = tmp;

    for i in 0..16 {
        state[i] ^= round_keys[14][i];
    }

    state
}

/// GHASH 계산
fn ghash(h: u128, aad: &[u8], ciphertext: &[u8]) -> u128 {
    let mut y: u128 = 0;

    // Process AAD
    for chunk in aad.chunks(16) {
        let mut block = [0u8; 16];
        block[..chunk.len()].copy_from_slice(chunk);
        let x = u128::from_be_bytes(block);
        y = gf_mult(y ^ x, h);
    }

    // Process ciphertext
    for chunk in ciphertext.chunks(16) {
        let mut block = [0u8; 16];
        block[..chunk.len()].copy_from_slice(chunk);
        let x = u128::from_be_bytes(block);
        y = gf_mult(y ^ x, h);
    }

    // Length block
    let len_block = ((aad.len() as u128 * 8) << 64) | (ciphertext.len() as u128 * 8);
    y = gf_mult(y ^ len_block, h);

    y
}

/// 세션 암호화 컨텍스트
#[wasm_bindgen]
pub struct CryptoSession {
    key: [u8; AES_KEY_SIZE],
    round_keys: [[u8; 16]; 15],
    nonce_counter: u64,
    random_prefix: [u8; 8],
    total_bytes_encrypted: u64,
    sequence: u32,
}

#[wasm_bindgen]
impl CryptoSession {
    /// 세션 키로부터 암호화 컨텍스트 생성
    #[wasm_bindgen(constructor)]
    pub fn new(session_key: &[u8], random_prefix: &[u8]) -> Result<CryptoSession, JsValue> {
        if session_key.len() != AES_KEY_SIZE {
            return Err(JsValue::from_str("Invalid key size: expected 32 bytes"));
        }
        if random_prefix.len() < 8 {
            return Err(JsValue::from_str(
                "Invalid random prefix: expected at least 8 bytes",
            ));
        }

        let mut key = [0u8; AES_KEY_SIZE];
        key.copy_from_slice(session_key);

        let round_keys = aes_key_expansion(&key);

        let mut prefix = [0u8; 8];
        prefix.copy_from_slice(&random_prefix[..8]);

        Ok(CryptoSession {
            key,
            round_keys,
            nonce_counter: 0,
            random_prefix: prefix,
            total_bytes_encrypted: 0,
            sequence: 0,
        })
    }

    /// Nonce 생성 (12 bytes)
    fn generate_nonce(&mut self) -> [u8; NONCE_SIZE] {
        let mut nonce = [0u8; NONCE_SIZE];
        nonce[..4].copy_from_slice(&self.nonce_counter.to_le_bytes()[..4]);
        nonce[4..12].copy_from_slice(&self.random_prefix);
        self.nonce_counter += 1;
        nonce
    }

    /// 🚀 [신규] In-Place 암호화 (Zero-Copy 지원)
    ///
    /// WASM 메모리 내의 데이터를 직접 암호화하여 불필요한 할당과 복사를 제거합니다.
    /// - buffer: 전체 패킷 버퍼 (헤더 공간 포함)
    /// - data_offset: 데이터가 시작되는 오프셋
    /// - data_len: 데이터 길이
    ///
    /// Returns: (nonce + tag)가 합쳐진 Vec<u8> 반환 (헤더 작성용)
    pub fn encrypt_in_place(
        &mut self,
        buffer: &mut [u8],
        data_offset: usize,
        data_len: usize,
    ) -> Result<Vec<u8>, JsValue> {
        let nonce = self.generate_nonce();

        // H = AES(K, 0^128)
        let h_block = aes_encrypt_block(&[0u8; 16], &self.round_keys);
        let h = u128::from_be_bytes(h_block);

        // Initial counter (J0)
        let mut j0 = [0u8; 16];
        j0[..12].copy_from_slice(&nonce);
        j0[15] = 1;

        let mut counter = j0;

        // 1. Encrypt plaintext with CTR mode (In-Place)
        // 슬라이스를 직접 수정하여 암호화 (복사 없음!)
        let data_end = data_offset + data_len;
        if data_end > buffer.len() {
            return Err(JsValue::from_str("Buffer too small for data"));
        }

        let data_slice = &mut buffer[data_offset..data_end];

        // 청크 단위로 순회하며 XOR (CTR Mode)
        for chunk in data_slice.chunks_mut(AES_BLOCK_SIZE) {
            // Increment counter
            let ctr_val = u32::from_be_bytes([counter[12], counter[13], counter[14], counter[15]]);
            let new_ctr = ctr_val.wrapping_add(1);
            counter[12..16].copy_from_slice(&new_ctr.to_be_bytes());

            let keystream = aes_encrypt_block(&counter, &self.round_keys);

            for j in 0..chunk.len() {
                chunk[j] ^= keystream[j];
            }
        }

        // 2. Calculate GHASH (on ciphertext)
        // 이미 data_slice는 암호화된 상태(ciphertext)임
        let ghash_val = ghash(h, &[], &buffer[data_offset..data_end]); // AAD는 비어있음

        // 3. Calculate tag: E(K, J0) XOR GHASH
        let e_j0 = aes_encrypt_block(&j0, &self.round_keys);
        let e_j0_val = u128::from_be_bytes(e_j0);
        let tag = (ghash_val ^ e_j0_val).to_be_bytes();

        // 결과: Nonce(12) + Tag(16) = 28 bytes 반환
        let mut result = Vec::with_capacity(NONCE_SIZE + AUTH_TAG_SIZE);
        result.extend_from_slice(&nonce);
        result.extend_from_slice(&tag);

        Ok(result)
    }

    /// AES-GCM 암호화
    fn aes_gcm_encrypt(&self, nonce: &[u8; NONCE_SIZE], plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
        // H = AES(K, 0^128)
        let h_block = aes_encrypt_block(&[0u8; 16], &self.round_keys);
        let h = u128::from_be_bytes(h_block);

        // Initial counter (J0)
        let mut j0 = [0u8; 16];
        j0[..12].copy_from_slice(nonce);
        j0[15] = 1;

        // Encrypt plaintext with CTR mode
        let mut ciphertext = Vec::with_capacity(plaintext.len());
        let mut counter = j0;

        for chunk in plaintext.chunks(AES_BLOCK_SIZE) {
            // Increment counter
            let ctr_val = u32::from_be_bytes([counter[12], counter[13], counter[14], counter[15]]);
            let new_ctr = ctr_val.wrapping_add(1);
            counter[12..16].copy_from_slice(&new_ctr.to_be_bytes());

            let keystream = aes_encrypt_block(&counter, &self.round_keys);

            for (i, &byte) in chunk.iter().enumerate() {
                ciphertext.push(byte ^ keystream[i]);
            }
        }

        // Calculate GHASH
        let ghash_val = ghash(h, aad, &ciphertext);

        // Calculate tag: E(K, J0) XOR GHASH
        let e_j0 = aes_encrypt_block(&j0, &self.round_keys);
        let e_j0_val = u128::from_be_bytes(e_j0);
        let tag = (ghash_val ^ e_j0_val).to_be_bytes();

        // Append tag
        ciphertext.extend_from_slice(&tag);

        ciphertext
    }

    /// AES-GCM 복호화
    fn aes_gcm_decrypt(
        &self,
        nonce: &[u8; NONCE_SIZE],
        ciphertext_with_tag: &[u8],
        aad: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        if ciphertext_with_tag.len() < AUTH_TAG_SIZE {
            return Err(JsValue::from_str("Ciphertext too short"));
        }

        let ciphertext_len = ciphertext_with_tag.len() - AUTH_TAG_SIZE;
        let ciphertext = &ciphertext_with_tag[..ciphertext_len];
        let received_tag = &ciphertext_with_tag[ciphertext_len..];

        // H = AES(K, 0^128)
        let h_block = aes_encrypt_block(&[0u8; 16], &self.round_keys);
        let h = u128::from_be_bytes(h_block);

        // Calculate expected tag
        let mut j0 = [0u8; 16];
        j0[..12].copy_from_slice(nonce);
        j0[15] = 1;

        let ghash_val = ghash(h, aad, ciphertext);
        let e_j0 = aes_encrypt_block(&j0, &self.round_keys);
        let e_j0_val = u128::from_be_bytes(e_j0);
        let expected_tag = (ghash_val ^ e_j0_val).to_be_bytes();

        // Constant-time tag comparison
        let mut diff = 0u8;
        for (a, b) in expected_tag.iter().zip(received_tag.iter()) {
            diff |= a ^ b;
        }

        if diff != 0 {
            return Err(JsValue::from_str("Authentication failed"));
        }

        // Decrypt with CTR mode
        let mut plaintext = Vec::with_capacity(ciphertext_len);
        let mut counter = j0;

        for chunk in ciphertext.chunks(AES_BLOCK_SIZE) {
            let ctr_val = u32::from_be_bytes([counter[12], counter[13], counter[14], counter[15]]);
            let new_ctr = ctr_val.wrapping_add(1);
            counter[12..16].copy_from_slice(&new_ctr.to_be_bytes());

            let keystream = aes_encrypt_block(&counter, &self.round_keys);

            for (i, &byte) in chunk.iter().enumerate() {
                plaintext.push(byte ^ keystream[i]);
            }
        }

        Ok(plaintext)
    }

    /// 청크 암호화 (패킷 생성 포함)
    pub fn encrypt_chunk(&mut self, plaintext: &[u8]) -> Vec<u8> {
        let nonce = self.generate_nonce();
        let ciphertext = self.aes_gcm_encrypt(&nonce, plaintext, &[]);

        // 암호화된 패킷 생성
        let total_size = ENCRYPTED_HEADER_SIZE + ciphertext.len();
        let mut packet = vec![0u8; total_size];

        // Header
        packet[0] = CRYPTO_VERSION;
        packet[1] = flags::ENCRYPTED;
        packet[2..4].copy_from_slice(&0u16.to_le_bytes()); // file_index
        packet[4..8].copy_from_slice(&self.sequence.to_le_bytes());
        packet[8..16].copy_from_slice(&self.total_bytes_encrypted.to_le_bytes());
        packet[16..20].copy_from_slice(&(plaintext.len() as u32).to_le_bytes());
        packet[20..32].copy_from_slice(&nonce);
        // [32..36] reserved

        // Ciphertext + Tag
        packet[ENCRYPTED_HEADER_SIZE..].copy_from_slice(&ciphertext);

        self.sequence += 1;
        self.total_bytes_encrypted += plaintext.len() as u64;

        packet
    }

    /// 청크 복호화
    pub fn decrypt_chunk(&self, packet: &[u8]) -> Result<Vec<u8>, JsValue> {
        if packet.len() < ENCRYPTED_HEADER_SIZE + AUTH_TAG_SIZE {
            return Err(JsValue::from_str("Packet too short"));
        }

        let header = EncryptedPacketHeader::from_bytes(packet)
            .ok_or_else(|| JsValue::from_str("Invalid header"))?;

        if !header.is_encrypted() {
            return Err(JsValue::from_str("Packet not encrypted"));
        }

        let mut nonce = [0u8; NONCE_SIZE];
        nonce.copy_from_slice(&header.nonce[..NONCE_SIZE]);

        let ciphertext_with_tag = &packet[ENCRYPTED_HEADER_SIZE..];

        self.aes_gcm_decrypt(&nonce, ciphertext_with_tag, &[])
    }

    /// 총 암호화된 바이트 수
    #[wasm_bindgen(getter)]
    pub fn total_bytes_encrypted(&self) -> u64 {
        self.total_bytes_encrypted
    }

    /// 시퀀스 번호
    #[wasm_bindgen(getter)]
    pub fn sequence(&self) -> u32 {
        self.sequence
    }

    /// 리셋
    pub fn reset(&mut self) {
        self.nonce_counter = 0;
        self.total_bytes_encrypted = 0;
        self.sequence = 0;
    }
}

impl Drop for CryptoSession {
    fn drop(&mut self) {
        // 키 메모리 제로화
        self.key.fill(0);
        for rk in &mut self.round_keys {
            rk.fill(0);
        }
    }
}

/// 내부 테스트용 복호화 (JsValue 없이)
#[cfg(test)]
impl CryptoSession {
    fn decrypt_chunk_test(&self, packet: &[u8]) -> Result<Vec<u8>, &'static str> {
        if packet.len() < ENCRYPTED_HEADER_SIZE + AUTH_TAG_SIZE {
            return Err("Packet too short");
        }

        let header = EncryptedPacketHeader::from_bytes(packet).ok_or("Invalid header")?;

        if !header.is_encrypted() {
            return Err("Packet not encrypted");
        }

        let mut nonce = [0u8; NONCE_SIZE];
        nonce.copy_from_slice(&header.nonce[..NONCE_SIZE]);

        let ciphertext_with_tag = &packet[ENCRYPTED_HEADER_SIZE..];

        self.aes_gcm_decrypt_test(&nonce, ciphertext_with_tag, &[])
    }

    fn aes_gcm_decrypt_test(
        &self,
        nonce: &[u8; NONCE_SIZE],
        ciphertext_with_tag: &[u8],
        aad: &[u8],
    ) -> Result<Vec<u8>, &'static str> {
        if ciphertext_with_tag.len() < AUTH_TAG_SIZE {
            return Err("Ciphertext too short");
        }

        let ciphertext_len = ciphertext_with_tag.len() - AUTH_TAG_SIZE;
        let ciphertext = &ciphertext_with_tag[..ciphertext_len];
        let received_tag = &ciphertext_with_tag[ciphertext_len..];

        let h_block = aes_encrypt_block(&[0u8; 16], &self.round_keys);
        let h = u128::from_be_bytes(h_block);

        let mut j0 = [0u8; 16];
        j0[..12].copy_from_slice(nonce);
        j0[15] = 1;

        let ghash_val = ghash(h, aad, ciphertext);
        let e_j0 = aes_encrypt_block(&j0, &self.round_keys);
        let e_j0_val = u128::from_be_bytes(e_j0);
        let expected_tag = (ghash_val ^ e_j0_val).to_be_bytes();

        let mut diff = 0u8;
        for (a, b) in expected_tag.iter().zip(received_tag.iter()) {
            diff |= a ^ b;
        }

        if diff != 0 {
            return Err("Authentication failed");
        }

        let mut plaintext = Vec::with_capacity(ciphertext_len);
        let mut counter = j0;

        for chunk in ciphertext.chunks(AES_BLOCK_SIZE) {
            let ctr_val = u32::from_be_bytes([counter[12], counter[13], counter[14], counter[15]]);
            let new_ctr = ctr_val.wrapping_add(1);
            counter[12..16].copy_from_slice(&new_ctr.to_be_bytes());

            let keystream = aes_encrypt_block(&counter, &self.round_keys);

            for (i, &byte) in chunk.iter().enumerate() {
                plaintext.push(byte ^ keystream[i]);
            }
        }

        Ok(plaintext)
    }

    fn new_test(session_key: &[u8], random_prefix: &[u8]) -> Result<CryptoSession, &'static str> {
        if session_key.len() != AES_KEY_SIZE {
            return Err("Invalid key size");
        }
        if random_prefix.len() < 8 {
            return Err("Invalid random prefix");
        }

        let mut key = [0u8; AES_KEY_SIZE];
        key.copy_from_slice(session_key);

        let round_keys = aes_key_expansion(&key);

        let mut prefix = [0u8; 8];
        prefix.copy_from_slice(&random_prefix[..8]);

        Ok(CryptoSession {
            key,
            round_keys,
            nonce_counter: 0,
            random_prefix: prefix,
            total_bytes_encrypted: 0,
            sequence: 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = [0x42u8; 32];
        let random_prefix = [0x12u8; 8];

        let mut session = CryptoSession::new_test(&key, &random_prefix).unwrap();

        let plaintext = b"Hello, PonsWarp E2E Encryption!";
        let packet = session.encrypt_chunk(plaintext);

        let session2 = CryptoSession::new_test(&key, &random_prefix).unwrap();
        let decrypted = session2.decrypt_chunk_test(&packet).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_tampered_packet() {
        let key = [0x42u8; 32];
        let random_prefix = [0x12u8; 8];

        let mut session = CryptoSession::new_test(&key, &random_prefix).unwrap();

        let plaintext = b"Secret data";
        let mut packet = session.encrypt_chunk(plaintext);

        // 데이터 변조
        packet[ENCRYPTED_HEADER_SIZE] ^= 0xFF;

        let session2 = CryptoSession::new_test(&key, &random_prefix).unwrap();
        let result = session2.decrypt_chunk_test(&packet);

        assert!(result.is_err());
    }

    #[test]
    fn test_sequence_increment() {
        let key = [0x42u8; 32];
        let random_prefix = [0x12u8; 8];

        let mut session = CryptoSession::new_test(&key, &random_prefix).unwrap();

        session.encrypt_chunk(b"chunk1");
        assert_eq!(session.sequence(), 1);

        session.encrypt_chunk(b"chunk2");
        assert_eq!(session.sequence(), 2);
    }
}
