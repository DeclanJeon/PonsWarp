//! Reed-Solomon FEC 구현
//!
//! GF(2^8) 기반 Reed-Solomon 인코딩/디코딩
//! - 데이터 샤드: 10개
//! - 패리티 샤드: 4개 (40% 오버헤드)
//! - 최대 4개 샤드 손실까지 복구 가능

use wasm_bindgen::prelude::*;

/// 기본 데이터 샤드 수
pub const DEFAULT_DATA_SHARDS: usize = 10;
/// 기본 패리티 샤드 수  
pub const DEFAULT_PARITY_SHARDS: usize = 4;

/// GF(2^8) 원시 다항식: x^8 + x^4 + x^3 + x^2 + 1
const GF_PRIMITIVE: u16 = 0x11d;

/// GF(2^8) 지수 테이블
const GF_EXP: [u8; 512] = {
    let mut exp = [0u8; 512];
    let mut x: u16 = 1;
    let mut i = 0;
    while i < 255 {
        exp[i] = x as u8;
        exp[i + 255] = x as u8;
        x <<= 1;
        if x >= 256 {
            x ^= GF_PRIMITIVE;
        }
        i += 1;
    }
    exp[255] = exp[0];
    exp[510] = exp[0];
    exp
};

/// GF(2^8) 로그 테이블
const GF_LOG: [u8; 256] = {
    let mut log = [0u8; 256];
    let mut x: u16 = 1;
    let mut i = 0u8;
    while i < 255 {
        log[x as usize] = i;
        x <<= 1;
        if x >= 256 {
            x ^= GF_PRIMITIVE;
        }
        i += 1;
    }
    log
};

/// GF(2^8) 곱셈
#[inline]
fn gf_mul(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        0
    } else {
        GF_EXP[(GF_LOG[a as usize] as usize) + (GF_LOG[b as usize] as usize)]
    }
}

/// GF(2^8) 나눗셈
#[cfg(test)]
#[inline]
fn gf_div(a: u8, b: u8) -> u8 {
    if a == 0 {
        0
    } else if b == 0 {
        panic!("Division by zero in GF(2^8)")
    } else {
        let log_a = GF_LOG[a as usize] as i16;
        let log_b = GF_LOG[b as usize] as i16;
        let mut diff = log_a - log_b;
        if diff < 0 {
            diff += 255;
        }
        GF_EXP[diff as usize]
    }
}

/// GF(2^8) 역원
#[inline]
fn gf_inv(a: u8) -> u8 {
    if a == 0 {
        panic!("Inverse of zero in GF(2^8)")
    } else {
        GF_EXP[255 - GF_LOG[a as usize] as usize]
    }
}

/// Vandermonde 행렬 생성
fn build_vandermonde_matrix(rows: usize, cols: usize) -> Vec<Vec<u8>> {
    let mut matrix = vec![vec![0u8; cols]; rows];
    for (r, row) in matrix.iter_mut().enumerate().take(rows) {
        for (c, cell) in row.iter_mut().enumerate().take(cols) {
            if r < cols {
                // 단위 행렬 부분 (데이터 샤드)
                *cell = if r == c { 1 } else { 0 };
            } else {
                // Vandermonde 부분 (패리티 샤드)
                let exp = (r - cols) * c;
                *cell = if exp == 0 { 1 } else { GF_EXP[exp % 255] };
            }
        }
    }
    matrix
}

/// Reed-Solomon 인코더
#[wasm_bindgen]
pub struct ReedSolomonEncoder {
    data_shards: usize,
    parity_shards: usize,
    total_shards: usize,
    matrix: Vec<Vec<u8>>,
}

#[wasm_bindgen]
impl ReedSolomonEncoder {
    /// 새 인코더 생성
    #[wasm_bindgen(constructor)]
    pub fn new(data_shards: usize, parity_shards: usize) -> Result<ReedSolomonEncoder, JsValue> {
        if data_shards == 0 || parity_shards == 0 {
            return Err(JsValue::from_str("Shard counts must be positive"));
        }
        if data_shards + parity_shards > 255 {
            return Err(JsValue::from_str("Total shards must be <= 255"));
        }

        let total_shards = data_shards + parity_shards;
        let matrix = build_vandermonde_matrix(total_shards, data_shards);

        Ok(Self {
            data_shards,
            parity_shards,
            total_shards,
            matrix,
        })
    }

    /// 기본 설정으로 인코더 생성 (10 data, 4 parity)
    #[wasm_bindgen(js_name = withDefaults)]
    pub fn with_defaults() -> ReedSolomonEncoder {
        Self::new(DEFAULT_DATA_SHARDS, DEFAULT_PARITY_SHARDS).unwrap()
    }

    /// 데이터에서 패리티 샤드 생성
    ///
    /// - data: 원본 데이터 (data_shards * shard_size 바이트)
    /// - shard_size: 각 샤드의 크기
    ///
    /// Returns: 패리티 샤드들 (parity_shards * shard_size 바이트)
    pub fn encode(&self, data: &[u8], shard_size: usize) -> Result<Vec<u8>, JsValue> {
        let expected_size = self.data_shards * shard_size;
        if data.len() != expected_size {
            return Err(JsValue::from_str(&format!(
                "Data size mismatch: expected {}, got {}",
                expected_size,
                data.len()
            )));
        }

        let mut parity = vec![0u8; self.parity_shards * shard_size];

        // 각 패리티 샤드 계산
        for p in 0..self.parity_shards {
            let parity_row = self.data_shards + p;
            let parity_offset = p * shard_size;

            for byte_idx in 0..shard_size {
                let mut val = 0u8;
                for d in 0..self.data_shards {
                    let data_byte = data[d * shard_size + byte_idx];
                    val ^= gf_mul(self.matrix[parity_row][d], data_byte);
                }
                parity[parity_offset + byte_idx] = val;
            }
        }

        Ok(parity)
    }

    /// 단일 블록 인코딩 (편의 메서드)
    ///
    /// 데이터를 자동으로 패딩하고 샤드로 분할합니다.
    pub fn encode_block(&self, data: &[u8]) -> Result<Vec<u8>, JsValue> {
        // 샤드 크기 계산 (패딩 포함)
        let shard_size = data.len().div_ceil(self.data_shards);
        let padded_size = shard_size * self.data_shards;

        // 패딩된 데이터 생성
        let mut padded = vec![0u8; padded_size];
        padded[..data.len()].copy_from_slice(data);

        // 패리티 생성
        let parity = self.encode(&padded, shard_size)?;

        // 결과: [원본 데이터 길이(4바이트)] + [패딩된 데이터] + [패리티]
        let mut result = Vec::with_capacity(4 + padded_size + parity.len());
        result.extend_from_slice(&(data.len() as u32).to_le_bytes());
        result.extend_from_slice(&padded);
        result.extend_from_slice(&parity);

        Ok(result)
    }

    #[wasm_bindgen(getter)]
    pub fn data_shards(&self) -> usize {
        self.data_shards
    }

    #[wasm_bindgen(getter)]
    pub fn parity_shards(&self) -> usize {
        self.parity_shards
    }

    #[wasm_bindgen(getter)]
    pub fn total_shards(&self) -> usize {
        self.total_shards
    }
}

/// Reed-Solomon 디코더
#[wasm_bindgen]
pub struct ReedSolomonDecoder {
    data_shards: usize,
    parity_shards: usize,
    total_shards: usize,
    matrix: Vec<Vec<u8>>,
    shard_size: usize,
    received: Vec<Option<Vec<u8>>>,
    received_count: usize,
}

#[wasm_bindgen]
impl ReedSolomonDecoder {
    /// 새 디코더 생성
    #[wasm_bindgen(constructor)]
    pub fn new(
        data_shards: usize,
        parity_shards: usize,
        shard_size: usize,
    ) -> Result<ReedSolomonDecoder, JsValue> {
        if data_shards == 0 || parity_shards == 0 {
            return Err(JsValue::from_str("Shard counts must be positive"));
        }
        if data_shards + parity_shards > 255 {
            return Err(JsValue::from_str("Total shards must be <= 255"));
        }

        let total_shards = data_shards + parity_shards;
        let matrix = build_vandermonde_matrix(total_shards, data_shards);

        Ok(Self {
            data_shards,
            parity_shards,
            total_shards,
            matrix,
            shard_size,
            received: vec![None; total_shards],
            received_count: 0,
        })
    }

    /// 샤드 수신
    ///
    /// Returns: 복구 가능 여부 (data_shards 개 이상 수신 시 true)
    pub fn receive_shard(&mut self, index: usize, data: &[u8]) -> bool {
        if index >= self.total_shards {
            return false;
        }
        if data.len() != self.shard_size {
            return false;
        }

        if self.received[index].is_none() {
            self.received[index] = Some(data.to_vec());
            self.received_count += 1;
        }

        self.received_count >= self.data_shards
    }

    /// 복구 가능 여부
    pub fn can_reconstruct(&self) -> bool {
        self.received_count >= self.data_shards
    }

    /// 수신된 샤드 수
    pub fn received_count(&self) -> usize {
        self.received_count
    }

    #[wasm_bindgen(getter)]
    pub fn parity_shards(&self) -> usize {
        self.parity_shards
    }

    /// 누락된 샤드 인덱스 목록
    pub fn missing_indices(&self) -> Vec<usize> {
        self.received
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_none())
            .map(|(i, _)| i)
            .collect()
    }

    /// 데이터 복구
    ///
    /// Returns: 복구된 원본 데이터 (data_shards * shard_size 바이트)
    pub fn reconstruct(&self) -> Result<Vec<u8>, JsValue> {
        if self.received_count < self.data_shards {
            return Err(JsValue::from_str(&format!(
                "Not enough shards: need {}, have {}",
                self.data_shards, self.received_count
            )));
        }

        // 수신된 샤드 인덱스 수집
        let present_indices: Vec<usize> = self
            .received
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_some())
            .map(|(i, _)| i)
            .take(self.data_shards)
            .collect();

        // 서브 행렬 추출
        let mut sub_matrix: Vec<Vec<u8>> = present_indices
            .iter()
            .map(|&i| self.matrix[i].clone())
            .collect();

        // 가우스 소거법으로 역행렬 계산
        let inv_matrix = self.invert_matrix(&mut sub_matrix)?;

        // 데이터 복구
        let mut result = vec![0u8; self.data_shards * self.shard_size];

        for byte_idx in 0..self.shard_size {
            for d in 0..self.data_shards {
                let mut val = 0u8;
                for (j, &src_idx) in present_indices.iter().enumerate() {
                    let src_byte = self.received[src_idx].as_ref().unwrap()[byte_idx];
                    val ^= gf_mul(inv_matrix[d][j], src_byte);
                }
                result[d * self.shard_size + byte_idx] = val;
            }
        }

        Ok(result)
    }

    /// 행렬 역변환 (가우스-조던 소거법)
    fn invert_matrix(&self, matrix: &mut [Vec<u8>]) -> Result<Vec<Vec<u8>>, JsValue> {
        let n = matrix.len();

        // 단위 행렬로 초기화
        let mut inv: Vec<Vec<u8>> = (0..n)
            .map(|i| {
                let mut row = vec![0u8; n];
                row[i] = 1;
                row
            })
            .collect();

        // 전진 소거
        for col in 0..n {
            // 피벗 찾기
            let mut pivot_row = col;
            for (row, matrix_row) in matrix.iter().enumerate().take(n).skip(col + 1) {
                if matrix_row[col] != 0 {
                    pivot_row = row;
                    break;
                }
            }

            if matrix[pivot_row][col] == 0 {
                return Err(JsValue::from_str("Matrix is singular"));
            }

            // 행 교환
            if pivot_row != col {
                matrix.swap(col, pivot_row);
                inv.swap(col, pivot_row);
            }

            // 피벗 정규화
            let pivot_val = matrix[col][col];
            let pivot_inv = gf_inv(pivot_val);
            for j in 0..n {
                matrix[col][j] = gf_mul(matrix[col][j], pivot_inv);
                inv[col][j] = gf_mul(inv[col][j], pivot_inv);
            }

            // 다른 행 소거
            for row in 0..n {
                if row != col && matrix[row][col] != 0 {
                    let factor = matrix[row][col];
                    for j in 0..n {
                        matrix[row][j] ^= gf_mul(factor, matrix[col][j]);
                        inv[row][j] ^= gf_mul(factor, inv[col][j]);
                    }
                }
            }
        }

        Ok(inv)
    }

    /// 리셋
    pub fn reset(&mut self) {
        self.received.fill(None);
        self.received_count = 0;
    }
}

/// 적응형 FEC 레벨 관리자
///
/// 네트워크 상태에 따라 패리티 레벨을 동적으로 조정합니다.
#[wasm_bindgen]
pub struct AdaptiveFec {
    /// 현재 패리티 샤드 수
    current_parity: usize,
    /// 최소 패리티 샤드 수
    min_parity: usize,
    /// 최대 패리티 샤드 수
    max_parity: usize,
    /// 데이터 샤드 수
    data_shards: usize,
    /// 최근 손실률 (0.0 ~ 1.0)
    loss_rate: f64,
    /// 손실률 이동 평균 가중치
    alpha: f64,
}

#[wasm_bindgen]
impl AdaptiveFec {
    #[wasm_bindgen(constructor)]
    pub fn new(data_shards: usize, min_parity: usize, max_parity: usize) -> Self {
        Self {
            current_parity: min_parity,
            min_parity,
            max_parity,
            data_shards,
            loss_rate: 0.0,
            alpha: 0.3, // EWMA 가중치
        }
    }

    /// 기본 설정 (10 data, 2-6 parity)
    #[wasm_bindgen(js_name = withDefaults)]
    pub fn with_defaults() -> Self {
        Self::new(DEFAULT_DATA_SHARDS, 2, 6)
    }

    /// 패킷 손실 보고
    ///
    /// - total_sent: 전송한 총 패킷 수
    /// - lost: 손실된 패킷 수
    pub fn report_loss(&mut self, total_sent: usize, lost: usize) {
        if total_sent == 0 {
            return;
        }

        let current_loss = lost as f64 / total_sent as f64;

        // 지수 가중 이동 평균
        self.loss_rate = self.alpha * current_loss + (1.0 - self.alpha) * self.loss_rate;

        // 패리티 레벨 조정
        self.adjust_parity();
    }

    /// 패리티 레벨 조정
    fn adjust_parity(&mut self) {
        let target_parity = if self.loss_rate > 0.05 {
            // 5% 이상 손실: 최대 패리티
            self.max_parity
        } else if self.loss_rate > 0.02 {
            // 2-5% 손실: 높은 패리티
            (self.min_parity + self.max_parity).div_ceil(2)
        } else if self.loss_rate > 0.005 {
            // 0.5-2% 손실: 중간 패리티
            self.min_parity + 1
        } else {
            // 0.5% 미만: 최소 패리티
            self.min_parity
        };

        // 급격한 변화 방지 (한 번에 1단계씩만 조정)
        if target_parity > self.current_parity {
            self.current_parity = (self.current_parity + 1).min(self.max_parity);
        } else if target_parity < self.current_parity {
            self.current_parity = self.current_parity.saturating_sub(1).max(self.min_parity);
        }
    }

    /// 현재 패리티 샤드 수
    #[wasm_bindgen(getter)]
    pub fn current_parity(&self) -> usize {
        self.current_parity
    }

    /// 현재 손실률
    #[wasm_bindgen(getter)]
    pub fn loss_rate(&self) -> f64 {
        self.loss_rate
    }

    /// 현재 오버헤드 비율 (패리티/데이터)
    #[wasm_bindgen(getter)]
    pub fn overhead_ratio(&self) -> f64 {
        self.current_parity as f64 / self.data_shards as f64
    }

    /// 인코더 생성
    pub fn create_encoder(&self) -> Result<ReedSolomonEncoder, JsValue> {
        ReedSolomonEncoder::new(self.data_shards, self.current_parity)
    }

    /// 디코더 생성
    pub fn create_decoder(&self, shard_size: usize) -> Result<ReedSolomonDecoder, JsValue> {
        ReedSolomonDecoder::new(self.data_shards, self.current_parity, shard_size)
    }

    /// 리셋
    pub fn reset(&mut self) {
        self.current_parity = self.min_parity;
        self.loss_rate = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gf_operations() {
        // 곱셈 테스트
        assert_eq!(gf_mul(0, 5), 0);
        assert_eq!(gf_mul(5, 0), 0);
        assert_eq!(gf_mul(1, 5), 5);
        assert_eq!(gf_mul(5, 1), 5);

        // 나눗셈 테스트
        let a = 42u8;
        let b = 7u8;
        let c = gf_mul(a, b);
        assert_eq!(gf_div(c, b), a);

        // 역원 테스트
        for i in 1..=255u8 {
            let inv = gf_inv(i);
            assert_eq!(gf_mul(i, inv), 1);
        }
    }

    #[test]
    fn test_encode_decode_no_loss() {
        let encoder = ReedSolomonEncoder::new(4, 2).unwrap();
        let shard_size = 16;
        let data: Vec<u8> = (0..64).collect(); // 4 shards * 16 bytes

        let parity = encoder.encode(&data, shard_size).unwrap();
        assert_eq!(parity.len(), 2 * shard_size);

        // 모든 샤드 수신
        let mut decoder = ReedSolomonDecoder::new(4, 2, shard_size).unwrap();
        for i in 0..4 {
            let shard = &data[i * shard_size..(i + 1) * shard_size];
            decoder.receive_shard(i, shard);
        }

        assert!(decoder.can_reconstruct());
        let recovered = decoder.reconstruct().unwrap();
        assert_eq!(recovered, data);
    }

    #[test]
    fn test_encode_decode_with_loss() {
        let encoder = ReedSolomonEncoder::new(4, 2).unwrap();
        let shard_size = 16;
        let data: Vec<u8> = (0..64).collect();

        let parity = encoder.encode(&data, shard_size).unwrap();

        // 2개 데이터 샤드 손실, 패리티로 복구
        let mut decoder = ReedSolomonDecoder::new(4, 2, shard_size).unwrap();

        // 샤드 0, 1 손실 - 샤드 2, 3과 패리티 0, 1 사용
        decoder.receive_shard(2, &data[2 * shard_size..3 * shard_size]);
        decoder.receive_shard(3, &data[3 * shard_size..4 * shard_size]);
        decoder.receive_shard(4, &parity[0..shard_size]);
        decoder.receive_shard(5, &parity[shard_size..2 * shard_size]);

        assert!(decoder.can_reconstruct());
        let recovered = decoder.reconstruct().unwrap();
        assert_eq!(recovered, data);
    }

    #[test]
    fn test_adaptive_fec() {
        let mut fec = AdaptiveFec::new(10, 2, 6);

        assert_eq!(fec.current_parity(), 2);

        // 높은 손실률 보고
        fec.report_loss(100, 10); // 10% 손실
        assert!(fec.current_parity() > 2);

        // 계속 높은 손실
        for _ in 0..10 {
            fec.report_loss(100, 10);
        }
        assert_eq!(fec.current_parity(), 6); // 최대치

        // 손실 없음
        for _ in 0..20 {
            fec.report_loss(100, 0);
        }
        assert_eq!(fec.current_parity(), 2); // 최소치로 복귀
    }
}
