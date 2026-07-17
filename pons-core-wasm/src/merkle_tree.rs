//! Merkle Tree 무결성 검증
//!
//! 대용량 파일의 부분 무결성 검증을 위한 Merkle Tree 구현
//! - SHA-256 해시 사용
//! - 청크 단위 검증 지원
//! - 증명 경로 생성/검증

use std::num::Wrapping;
use wasm_bindgen::prelude::*;

const HASH_SIZE: usize = 32;

/// SHA-256 해시 계산
fn sha256(data: &[u8]) -> [u8; HASH_SIZE] {
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

    let bit_len = (data.len() as u64) * 8;
    let mut padded = data.to_vec();
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

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

        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);

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

/// 두 해시를 결합
fn hash_pair(left: &[u8; HASH_SIZE], right: &[u8; HASH_SIZE]) -> [u8; HASH_SIZE] {
    let mut combined = [0u8; HASH_SIZE * 2];
    combined[..HASH_SIZE].copy_from_slice(left);
    combined[HASH_SIZE..].copy_from_slice(right);
    sha256(&combined)
}

/// Merkle 증명 노드
#[wasm_bindgen(getter_with_clone)]
pub struct ProofNode {
    pub hash: Vec<u8>,
    pub is_left: bool,
}

/// Merkle Tree
#[wasm_bindgen]
pub struct MerkleTree {
    leaves: Vec<[u8; HASH_SIZE]>,
    tree: Vec<Vec<[u8; HASH_SIZE]>>,
    leaf_count: usize,
}

#[wasm_bindgen]
impl MerkleTree {
    /// 데이터 청크들로부터 Merkle Tree 생성
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            leaves: Vec::new(),
            tree: Vec::new(),
            leaf_count: 0,
        }
    }

    /// 청크 추가 (스트리밍 빌드)
    pub fn add_chunk(&mut self, data: &[u8]) {
        let hash = sha256(data);
        self.leaves.push(hash);
        self.leaf_count += 1;
    }

    /// 트리 빌드 완료
    pub fn finalize(&mut self) {
        if self.leaves.is_empty() {
            return;
        }

        self.tree.clear();

        // 리프 레벨
        let mut current_level = self.leaves.clone();

        // 홀수 개면 마지막 노드 복제
        if current_level.len() % 2 == 1 {
            let last = *current_level.last().unwrap();
            current_level.push(last);
        }

        self.tree.push(current_level.clone());

        // 상위 레벨 빌드
        while current_level.len() > 1 {
            let mut next_level = Vec::with_capacity(current_level.len().div_ceil(2));

            for pair in current_level.chunks(2) {
                let hash = if pair.len() == 2 {
                    hash_pair(&pair[0], &pair[1])
                } else {
                    hash_pair(&pair[0], &pair[0])
                };
                next_level.push(hash);
            }

            // 홀수 개면 마지막 노드 복제
            if next_level.len() > 1 && next_level.len() % 2 == 1 {
                let last = *next_level.last().unwrap();
                next_level.push(last);
            }

            self.tree.push(next_level.clone());
            current_level = next_level;
        }
    }

    /// 루트 해시 반환
    pub fn root(&self) -> Vec<u8> {
        if self.tree.is_empty() {
            return vec![0u8; HASH_SIZE];
        }
        self.tree.last().unwrap()[0].to_vec()
    }

    /// 리프 개수
    #[wasm_bindgen(getter)]
    pub fn leaf_count(&self) -> usize {
        self.leaf_count
    }

    /// 트리 높이
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> usize {
        self.tree.len()
    }

    /// 특정 청크의 증명 경로 생성
    pub fn get_proof(&self, index: usize) -> Vec<u8> {
        if index >= self.leaf_count || self.tree.is_empty() {
            return Vec::new();
        }

        let mut proof = Vec::new();
        let mut idx = index;

        for level in 0..self.tree.len() - 1 {
            let sibling_idx = if idx.is_multiple_of(2) {
                idx + 1
            } else {
                idx - 1
            };

            if sibling_idx < self.tree[level].len() {
                // is_left (1 byte) + hash (32 bytes)
                proof.push(if idx.is_multiple_of(2) { 0 } else { 1 });
                proof.extend_from_slice(&self.tree[level][sibling_idx]);
            }

            idx /= 2;
        }

        proof
    }

    /// 증명 검증
    pub fn verify_proof(root: &[u8], leaf_data: &[u8], _index: usize, proof: &[u8]) -> bool {
        if root.len() != HASH_SIZE || !proof.len().is_multiple_of(HASH_SIZE + 1) {
            return false;
        }

        let mut current_hash = sha256(leaf_data);

        for chunk in proof.chunks(HASH_SIZE + 1) {
            if chunk.len() != HASH_SIZE + 1 {
                return false;
            }

            let is_left = chunk[0] == 1;
            let mut sibling = [0u8; HASH_SIZE];
            sibling.copy_from_slice(&chunk[1..]);

            current_hash = if is_left {
                hash_pair(&sibling, &current_hash)
            } else {
                hash_pair(&current_hash, &sibling)
            };
        }

        current_hash == <[u8; HASH_SIZE]>::try_from(root).unwrap_or([0u8; HASH_SIZE])
    }

    /// 리셋
    pub fn reset(&mut self) {
        self.leaves.clear();
        self.tree.clear();
        self.leaf_count = 0;
    }
}

impl Default for MerkleTree {
    fn default() -> Self {
        Self::new()
    }
}

/// 단일 데이터의 SHA-256 해시
#[wasm_bindgen]
pub fn merkle_hash(data: &[u8]) -> Vec<u8> {
    sha256(data).to_vec()
}

/// 빠른 Merkle 루트 계산 (청크 배열)
#[wasm_bindgen]
pub fn compute_merkle_root(chunks: &[u8], chunk_size: usize) -> Vec<u8> {
    if chunks.is_empty() || chunk_size == 0 {
        return vec![0u8; HASH_SIZE];
    }

    let mut tree = MerkleTree::new();
    for chunk in chunks.chunks(chunk_size) {
        tree.add_chunk(chunk);
    }
    tree.finalize();
    tree.root()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merkle_tree_basic() {
        let mut tree = MerkleTree::new();
        tree.add_chunk(b"chunk1");
        tree.add_chunk(b"chunk2");
        tree.add_chunk(b"chunk3");
        tree.add_chunk(b"chunk4");
        tree.finalize();

        assert_eq!(tree.leaf_count(), 4);
        assert!(!tree.root().is_empty());
    }

    #[test]
    fn test_proof_verification() {
        let mut tree = MerkleTree::new();
        let chunks = [b"chunk1", b"chunk2", b"chunk3", b"chunk4"];

        for chunk in &chunks {
            tree.add_chunk(*chunk);
        }
        tree.finalize();

        let root = tree.root();

        // 각 청크에 대한 증명 검증
        for (i, chunk) in chunks.iter().enumerate() {
            let proof = tree.get_proof(i);
            assert!(MerkleTree::verify_proof(&root, *chunk, i, &proof));
        }
    }

    #[test]
    fn test_tampered_data() {
        let mut tree = MerkleTree::new();
        tree.add_chunk(b"chunk1");
        tree.add_chunk(b"chunk2");
        tree.finalize();

        let root = tree.root();
        let proof = tree.get_proof(0);

        // 원본 데이터로 검증 - 성공
        assert!(MerkleTree::verify_proof(&root, b"chunk1", 0, &proof));

        // 변조된 데이터로 검증 - 실패
        assert!(!MerkleTree::verify_proof(&root, b"tampered", 0, &proof));
    }

    #[test]
    fn test_single_chunk() {
        let mut tree = MerkleTree::new();
        tree.add_chunk(b"single");
        tree.finalize();

        assert_eq!(tree.leaf_count(), 1);
        assert!(!tree.root().is_empty());
    }
}
