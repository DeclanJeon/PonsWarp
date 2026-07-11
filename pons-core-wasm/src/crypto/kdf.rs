//! HKDF 키 유도 함수
//!
//! ECDH 공유 비밀에서 세션 키를 유도합니다.

use wasm_bindgen::prelude::*;

/// HKDF-SHA256 출력 키 크기 (32 bytes = 256 bits)
pub const KEY_SIZE: usize = 32;

/// HKDF 정보 문자열
const HKDF_INFO: &[u8] = b"PonsWarp-E2E-v1";

/// HMAC-SHA256 블록 크기
const HMAC_BLOCK_SIZE: usize = 64;

/// SHA256 출력 크기
const SHA256_OUTPUT_SIZE: usize = 32;

/// 간단한 SHA256 구현 (WASM용)
/// 프로덕션에서는 Web Crypto API 사용 권장
fn sha256(data: &[u8]) -> [u8; 32] {
    use std::num::Wrapping;

    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut h: [Wrapping<u32>; 8] = [
        Wrapping(0x6a09e667),
        Wrapping(0xbb67ae85),
        Wrapping(0x3c6ef372),
        Wrapping(0xa54ff53a),
        Wrapping(0x510e527f),
        Wrapping(0x9b05688c),
        Wrapping(0x1f83d9ab),
        Wrapping(0x5be0cd19),
    ];

    // Padding
    let bit_len = (data.len() as u64) * 8;
    let mut padded = data.to_vec();
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    // Process blocks
    for chunk in padded.chunks(64) {
        let mut w = [Wrapping(0u32); 64];
        for (i, word) in chunk.chunks(4).enumerate() {
            w[i] = Wrapping(u32::from_be_bytes([word[0], word[1], word[2], word[3]]));
        }

        for i in 16..64 {
            let s0 =
                (w[i - 15].0.rotate_right(7)) ^ (w[i - 15].0.rotate_right(18)) ^ (w[i - 15].0 >> 3);
            let s1 =
                (w[i - 2].0.rotate_right(17)) ^ (w[i - 2].0.rotate_right(19)) ^ (w[i - 2].0 >> 10);
            w[i] = w[i - 16] + Wrapping(s0) + w[i - 7] + Wrapping(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for i in 0..64 {
            let s1 = (e.0.rotate_right(6)) ^ (e.0.rotate_right(11)) ^ (e.0.rotate_right(25));
            let ch = (e.0 & f.0) ^ ((!e.0) & g.0);
            let temp1 = hh + Wrapping(s1) + Wrapping(ch) + Wrapping(K[i]) + w[i];
            let s0 = (a.0.rotate_right(2)) ^ (a.0.rotate_right(13)) ^ (a.0.rotate_right(22));
            let maj = (a.0 & b.0) ^ (a.0 & c.0) ^ (b.0 & c.0);
            let temp2 = Wrapping(s0) + Wrapping(maj);

            hh = g;
            g = f;
            f = e;
            e = d + temp1;
            d = c;
            c = b;
            b = a;
            a = temp1 + temp2;
        }

        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
        h[5] += f;
        h[6] += g;
        h[7] += hh;
    }

    let mut result = [0u8; 32];
    for (i, val) in h.iter().enumerate() {
        result[i * 4..(i + 1) * 4].copy_from_slice(&val.0.to_be_bytes());
    }
    result
}

/// HMAC-SHA256
fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut k = [0u8; HMAC_BLOCK_SIZE];

    if key.len() > HMAC_BLOCK_SIZE {
        let hash = sha256(key);
        k[..SHA256_OUTPUT_SIZE].copy_from_slice(&hash);
    } else {
        k[..key.len()].copy_from_slice(key);
    }

    let mut i_key_pad = [0x36u8; HMAC_BLOCK_SIZE];
    let mut o_key_pad = [0x5cu8; HMAC_BLOCK_SIZE];

    for i in 0..HMAC_BLOCK_SIZE {
        i_key_pad[i] ^= k[i];
        o_key_pad[i] ^= k[i];
    }

    let mut inner = Vec::with_capacity(HMAC_BLOCK_SIZE + data.len());
    inner.extend_from_slice(&i_key_pad);
    inner.extend_from_slice(data);
    let inner_hash = sha256(&inner);

    let mut outer = Vec::with_capacity(HMAC_BLOCK_SIZE + SHA256_OUTPUT_SIZE);
    outer.extend_from_slice(&o_key_pad);
    outer.extend_from_slice(&inner_hash);

    sha256(&outer)
}

/// HKDF-Extract (RFC 5869)
fn hkdf_extract(salt: &[u8], ikm: &[u8]) -> [u8; 32] {
    let actual_salt = if salt.is_empty() {
        [0u8; SHA256_OUTPUT_SIZE]
    } else {
        let mut s = [0u8; SHA256_OUTPUT_SIZE];
        let len = salt.len().min(SHA256_OUTPUT_SIZE);
        s[..len].copy_from_slice(&salt[..len]);
        s
    };

    hmac_sha256(&actual_salt, ikm)
}

/// HKDF-Expand (RFC 5869)
fn hkdf_expand(prk: &[u8; 32], info: &[u8], length: usize) -> Vec<u8> {
    let n = length.div_ceil(SHA256_OUTPUT_SIZE);
    let mut okm = Vec::with_capacity(n * SHA256_OUTPUT_SIZE);
    let mut t = Vec::new();

    for i in 1..=n {
        let mut data = Vec::with_capacity(t.len() + info.len() + 1);
        data.extend_from_slice(&t);
        data.extend_from_slice(info);
        data.push(i as u8);

        t = hmac_sha256(prk, &data).to_vec();
        okm.extend_from_slice(&t);
    }

    okm.truncate(length);
    okm
}

/// HKDF 키 유도 함수
#[wasm_bindgen]
pub fn derive_session_key(shared_secret: &[u8], salt: &[u8]) -> Vec<u8> {
    let prk = hkdf_extract(salt, shared_secret);
    hkdf_expand(&prk, HKDF_INFO, KEY_SIZE)
}

/// 키 확인용 HMAC 생성
#[wasm_bindgen]
pub fn create_key_confirmation(session_key: &[u8]) -> Vec<u8> {
    hmac_sha256(session_key, b"KEY_CONFIRM").to_vec()
}

/// 키 확인 검증
#[wasm_bindgen]
pub fn verify_key_confirmation(session_key: &[u8], confirmation: &[u8]) -> bool {
    let expected = hmac_sha256(session_key, b"KEY_CONFIRM");

    if confirmation.len() != expected.len() {
        return false;
    }

    // Constant-time comparison
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(confirmation.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256() {
        let result = sha256(b"hello");
        let expected = [
            0x2c, 0xf2, 0x4d, 0xba, 0x5f, 0xb0, 0xa3, 0x0e, 0x26, 0xe8, 0x3b, 0x2a, 0xc5, 0xb9,
            0xe2, 0x9e, 0x1b, 0x16, 0x1e, 0x5c, 0x1f, 0xa7, 0x42, 0x5e, 0x73, 0x04, 0x33, 0x62,
            0x93, 0x8b, 0x98, 0x24,
        ];
        assert_eq!(result, expected);
    }

    #[test]
    fn test_key_derivation() {
        let shared_secret = b"test_shared_secret_32_bytes_long";
        let salt = b"random_salt_value";

        let key1 = derive_session_key(shared_secret, salt);
        let key2 = derive_session_key(shared_secret, salt);

        assert_eq!(key1.len(), KEY_SIZE);
        assert_eq!(key1, key2); // 동일 입력 = 동일 출력
    }

    #[test]
    fn test_key_confirmation() {
        let session_key = derive_session_key(b"shared_secret", b"salt");
        let confirmation = create_key_confirmation(&session_key);

        assert!(verify_key_confirmation(&session_key, &confirmation));
        assert!(!verify_key_confirmation(
            &session_key,
            b"wrong_confirmation"
        ));
    }
}
