use crate::crc32::calculate_crc32;
use crate::crypto::{flags, CryptoSession, CRYPTO_VERSION};
use wasm_bindgen::prelude::*;

// 🚀 상수 업데이트: 가변 오프셋 전략 적용
const STANDARD_HEADER_SIZE: usize = 22;
const ENCRYPTED_HEADER_SIZE_CONST: usize = 38; // 38 bytes
                                               // 둘 중 큰 값 (데이터 시작 위치 기준점)
const MAX_HEADER_SIZE: usize = 38;
const AUTH_TAG_SIZE: usize = 16;

// 슬롯 크기: 64KB 데이터 + 헤더(38) + 태그(16) + 여유분
const SLOT_SIZE: usize = 64 * 1024 + 128;
const POOL_SLOTS: usize = 64;

#[derive(Clone, Copy, PartialEq, Debug)]
enum SlotState {
    Free,
    Acquired,
    CommittedStandard,  // 일반 패킷
    CommittedEncrypted, // 암호화 패킷
}

/// Zero-Copy 패킷 풀
///
/// WASM 선형 메모리 내에서 사전 할당된 버퍼를 사용하여
/// JS ↔ WASM 경계에서의 메모리 복사를 최소화합니다.
///
/// ## 사용 흐름
/// 1. `acquire_slot()` - 쓰기용 슬롯 획득
/// 2. JS에서 WASM 메모리에 직접 데이터 쓰기
/// 3. `commit_slot()` - 헤더 생성 및 CRC 계산
/// 4. `get_packet_view()` - WebRTC 전송용 포인터 획득
/// 5. `release_slot()` - 전송 완료 후 슬롯 반환
#[wasm_bindgen]
pub struct ZeroCopyPacketPool {
    buffer: Vec<u8>,
    states: Vec<SlotState>,
    // 🚀 패킷별 실제 시작 오프셋 저장 (가변 오프셋 지원용)
    packet_starts: Vec<usize>,
    sequence: u32,
    total_bytes: u64,
    next_acquire: usize,
}

#[wasm_bindgen]
impl ZeroCopyPacketPool {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            buffer: vec![0u8; SLOT_SIZE * POOL_SLOTS],
            states: vec![SlotState::Free; POOL_SLOTS],
            packet_starts: vec![0; POOL_SLOTS],
            sequence: 0,
            total_bytes: 0,
            next_acquire: 0,
        }
    }

    /// 커스텀 슬롯 수로 풀 생성
    #[wasm_bindgen(js_name = withCapacity)]
    pub fn with_capacity(slot_count: usize) -> Self {
        let slots = slot_count.clamp(1, 256);
        Self {
            buffer: vec![0u8; SLOT_SIZE * slots],
            states: vec![SlotState::Free; slots],
            packet_starts: vec![0; slots],
            sequence: 0,
            total_bytes: 0,
            next_acquire: 0,
        }
    }

    /// 슬롯 획득 - JS가 데이터를 쓸 위치 반환
    /// 🚀 핵심: 항상 MAX_HEADER_SIZE(38) 뒤를 데이터 시작점으로 반환
    pub fn acquire_slot(&mut self) -> Vec<i32> {
        let slots_count = self.states.len();

        for _ in 0..slots_count {
            let slot_id = self.next_acquire;
            self.next_acquire = (self.next_acquire + 1) % slots_count;

            if self.states[slot_id] == SlotState::Free {
                self.states[slot_id] = SlotState::Acquired;

                let base_offset = slot_id * SLOT_SIZE;
                // 항상 최대 헤더 크기만큼 띄우고 데이터 시작
                let data_offset = base_offset + MAX_HEADER_SIZE;

                // 데이터 공간 = 슬롯 - 헤더영역 - 태그영역
                let max_data = SLOT_SIZE - MAX_HEADER_SIZE - AUTH_TAG_SIZE;

                // WASM 선형 메모리 내 절대 주소 계산
                let data_ptr = self.buffer.as_ptr() as usize + data_offset;

                return vec![slot_id as i32, data_ptr as i32, max_data as i32];
            }
        }
        vec![-1, 0, 0]
    }

    /// 일반(평문) 패킷 커밋
    /// 🚀 22바이트 헤더를 [16..38] 구간에 작성하여 38부터 시작하는 데이터와 이어지게 함
    /// (38 - 22 = 16)
    pub fn commit_slot(&mut self, slot_id: usize, data_len: usize) -> usize {
        if !self.validate_slot(slot_id, data_len) {
            return 0;
        }

        let base_ptr = slot_id * SLOT_SIZE;
        // 일반 헤더 시작점: 16번 바이트
        let header_start = base_ptr + (MAX_HEADER_SIZE - STANDARD_HEADER_SIZE);
        let data_start = base_ptr + MAX_HEADER_SIZE;
        let data_end = data_start + data_len;

        // CRC32 계산
        let data_slice = &self.buffer[data_start..data_end];
        let checksum = calculate_crc32(data_slice);

        // 헤더 작성 (offset 16부터 작성)
        self.buffer[header_start..header_start + 2].copy_from_slice(&0u16.to_le_bytes()); // FileIndex
        self.buffer[header_start + 2..header_start + 6]
            .copy_from_slice(&self.sequence.to_le_bytes());
        self.buffer[header_start + 6..header_start + 14]
            .copy_from_slice(&self.total_bytes.to_le_bytes());
        self.buffer[header_start + 14..header_start + 18]
            .copy_from_slice(&(data_len as u32).to_le_bytes());
        self.buffer[header_start + 18..header_start + 22].copy_from_slice(&checksum.to_le_bytes());

        // 상태 업데이트: header_start를 저장하여 나중에 get_packet_view에서 사용
        self.update_state(
            slot_id,
            data_len,
            SlotState::CommittedStandard,
            header_start,
        );

        STANDARD_HEADER_SIZE + data_len
    }

    /// 🚀 [신규] 암호화 패킷 커밋
    /// 🚀 38바이트 헤더를 [0..38] 구간에 작성하고 데이터는 In-Place 암호화 수행
    pub fn commit_encrypted_slot(
        &mut self,
        slot_id: usize,
        data_len: usize,
        session: &mut CryptoSession,
    ) -> usize {
        if !self.validate_slot(slot_id, data_len) {
            return 0;
        }

        let base_ptr = slot_id * SLOT_SIZE;
        let data_start = base_ptr + MAX_HEADER_SIZE; // 38번 바이트

        // 1. In-Place 암호화 수행
        // 데이터 영역을 직접 암호화하고 Nonce와 Tag를 받아옴
        let crypto_result = session.encrypt_in_place(&mut self.buffer, data_start, data_len);

        if let Ok(meta) = crypto_result {
            // meta: [Nonce(12) | Tag(16)]
            let nonce = &meta[..12];
            let tag = &meta[12..];

            // 2. Auth Tag 쓰기 (데이터 바로 뒤에 붙임)
            let tag_start = data_start + data_len;
            self.buffer[tag_start..tag_start + 16].copy_from_slice(tag);

            // 3. Encrypted Header 작성 (offset 0부터 작성)
            // [0] Version
            self.buffer[base_ptr] = CRYPTO_VERSION;
            // [1] Flags
            self.buffer[base_ptr + 1] = flags::ENCRYPTED;
            // [2-3] FileIndex
            self.buffer[base_ptr + 2..base_ptr + 4].copy_from_slice(&0u16.to_le_bytes());
            // [4-7] ChunkIndex
            self.buffer[base_ptr + 4..base_ptr + 8].copy_from_slice(&self.sequence.to_le_bytes());
            // [8-15] Offset
            self.buffer[base_ptr + 8..base_ptr + 16]
                .copy_from_slice(&self.total_bytes.to_le_bytes());
            // [16-19] Plaintext Length
            self.buffer[base_ptr + 16..base_ptr + 20]
                .copy_from_slice(&(data_len as u32).to_le_bytes());
            // [20-31] Nonce
            self.buffer[base_ptr + 20..base_ptr + 32].copy_from_slice(nonce);
            // [32-37] Reserved (Zero)
            self.buffer[base_ptr + 32..base_ptr + 38].fill(0);

            // 암호화된 전체 패킷 크기 = 헤더(38) + 데이터 + 태그(16)
            let total_packet_len = ENCRYPTED_HEADER_SIZE_CONST + data_len + AUTH_TAG_SIZE;

            // 상태 업데이트: base_ptr(0번)을 시작점으로 저장
            self.update_state(slot_id, data_len, SlotState::CommittedEncrypted, base_ptr);
            return total_packet_len;
        }

        // 실패 시
        self.states[slot_id] = SlotState::Free;
        0
    }

    /// 파일 인덱스를 지정하여 슬롯 커밋
    pub fn commit_slot_with_file_index(
        &mut self,
        slot_id: usize,
        data_len: usize,
        file_index: u16,
    ) -> usize {
        let slots_count = self.states.len();

        if slot_id >= slots_count || self.states[slot_id] != SlotState::Acquired {
            return 0;
        }

        // 데이터 길이 검증
        let max_data_size = SLOT_SIZE - MAX_HEADER_SIZE - AUTH_TAG_SIZE;
        if data_len > max_data_size {
            return 0;
        }

        let base_ptr = slot_id * SLOT_SIZE;
        let header_start = base_ptr + (MAX_HEADER_SIZE - STANDARD_HEADER_SIZE);
        let data_start = base_ptr + MAX_HEADER_SIZE;
        let data_end = data_start + data_len;

        // 버퍼 경계 확인
        if data_end > self.buffer.len() {
            return 0;
        }

        let data_slice = &self.buffer[data_start..data_end];
        let checksum = calculate_crc32(data_slice);

        self.buffer[header_start..header_start + 2].copy_from_slice(&file_index.to_le_bytes());
        self.buffer[header_start + 2..header_start + 6]
            .copy_from_slice(&self.sequence.to_le_bytes());
        self.buffer[header_start + 6..header_start + 14]
            .copy_from_slice(&self.total_bytes.to_le_bytes());
        self.buffer[header_start + 14..header_start + 18]
            .copy_from_slice(&(data_len as u32).to_le_bytes());
        self.buffer[header_start + 18..header_start + 22].copy_from_slice(&checksum.to_le_bytes());

        self.update_state(
            slot_id,
            data_len,
            SlotState::CommittedStandard,
            header_start,
        );

        STANDARD_HEADER_SIZE + data_len
    }

    /// 패킷 뷰 획득 (WebRTC 전송용)
    /// 🚀 저장해둔 오프셋(packet_starts)을 사용하여 올바른 시작 지점 반환
    pub fn get_packet_view(&self, slot_id: usize) -> Vec<usize> {
        if slot_id >= self.states.len() {
            return vec![0, 0];
        }

        let state = self.states[slot_id];
        if state != SlotState::CommittedStandard && state != SlotState::CommittedEncrypted {
            return vec![0, 0];
        }

        // commit 시 저장해둔 실제 시작 위치 사용
        // Standard: buffer_start + 16
        // Encrypted: buffer_start + 0
        let start_ptr = self.buffer.as_ptr() as usize + self.packet_starts[slot_id];

        let packet_len = if state == SlotState::CommittedStandard {
            // Standard Packet Length 계산
            // 헤더 내 Length 필드 위치: 시작점 + 14
            let len_offset = self.packet_starts[slot_id] + 14;
            let data_len = u32::from_le_bytes([
                self.buffer[len_offset],
                self.buffer[len_offset + 1],
                self.buffer[len_offset + 2],
                self.buffer[len_offset + 3],
            ]) as usize;
            STANDARD_HEADER_SIZE + data_len
        } else {
            // Encrypted Packet Length 계산
            // 헤더 내 Plaintext Length 필드 위치: 시작점 + 16
            let len_offset = self.packet_starts[slot_id] + 16;
            let data_len = u32::from_le_bytes([
                self.buffer[len_offset],
                self.buffer[len_offset + 1],
                self.buffer[len_offset + 2],
                self.buffer[len_offset + 3],
            ]) as usize;
            ENCRYPTED_HEADER_SIZE_CONST + data_len + AUTH_TAG_SIZE
        };

        vec![start_ptr, packet_len]
    }

    /// 슬롯 반환
    pub fn release_slot(&mut self, slot_id: usize) {
        if slot_id < self.states.len() {
            self.states[slot_id] = SlotState::Free;
        }
    }

    /// 여러 슬롯 일괄 반환
    pub fn release_slots(&mut self, slot_ids: &[usize]) {
        let slots_count = self.states.len();
        for &slot_id in slot_ids {
            if slot_id < slots_count {
                self.states[slot_id] = SlotState::Free;
            }
        }
    }

    /// WASM 메모리 버퍼 포인터 (JS에서 직접 접근용)
    pub fn get_buffer_ptr(&self) -> *const u8 {
        self.buffer.as_ptr()
    }

    /// 버퍼 전체 길이
    pub fn get_buffer_len(&self) -> usize {
        self.buffer.len()
    }

    /// 사용 가능한 슬롯 수
    pub fn available_slots(&self) -> usize {
        self.states
            .iter()
            .filter(|&&s| s == SlotState::Free)
            .count()
    }

    /// 커밋된 슬롯 수
    pub fn committed_slots(&self) -> usize {
        self.states
            .iter()
            .filter(|&&s| s == SlotState::CommittedStandard || s == SlotState::CommittedEncrypted)
            .count()
    }

    /// 전체 슬롯 수
    pub fn total_slots(&self) -> usize {
        self.states.len()
    }

    /// 슬롯 크기 (바이트)
    pub fn slot_size(&self) -> usize {
        SLOT_SIZE
    }

    /// 헤더 크기 (바이트)
    pub fn header_size(&self) -> usize {
        STANDARD_HEADER_SIZE
    }

    /// 내부 헬퍼: 슬롯 유효성 검사
    fn validate_slot(&mut self, slot_id: usize, data_len: usize) -> bool {
        if slot_id >= self.states.len() || self.states[slot_id] != SlotState::Acquired {
            return false;
        }
        // 데이터 최대 크기 체크 (헤더 및 태그 공간 제외)
        let max_data = SLOT_SIZE - MAX_HEADER_SIZE - AUTH_TAG_SIZE;
        if data_len > max_data {
            self.states[slot_id] = SlotState::Free; // Fail safe
            return false;
        }
        true
    }

    /// 내부 헬퍼: 상태 및 오프셋 업데이트
    fn update_state(
        &mut self,
        slot_id: usize,
        data_len: usize,
        state: SlotState,
        start_offset: usize,
    ) {
        self.sequence += 1;
        self.total_bytes += data_len as u64;
        self.states[slot_id] = state;
        // start_offset은 이미 buffer 내부의 절대 offset이므로 그대로 저장
        self.packet_starts[slot_id] = start_offset;
    }

    /// 리셋 - 모든 상태 초기화
    pub fn reset(&mut self) {
        self.states.fill(SlotState::Free);
        self.packet_starts.fill(0);
        self.sequence = 0;
        self.total_bytes = 0;
        self.next_acquire = 0;
    }

    /// 시퀀스 번호 설정 (재개 시 사용)
    pub fn set_sequence(&mut self, seq: u32) {
        self.sequence = seq;
    }

    /// 총 바이트 설정 (재개 시 사용)
    pub fn set_total_bytes(&mut self, bytes: u64) {
        self.total_bytes = bytes;
    }

    #[wasm_bindgen(getter)]
    pub fn sequence(&self) -> u32 {
        self.sequence
    }

    #[wasm_bindgen(getter)]
    pub fn total_bytes(&self) -> u64 {
        self.total_bytes
    }
}

impl Default for ZeroCopyPacketPool {
    fn default() -> Self {
        Self::new()
    }
}

/// 배치 처리를 위한 슬롯 정보
#[wasm_bindgen(getter_with_clone)]
pub struct SlotInfo {
    pub slot_id: i32,
    pub data_ptr: i32,
    pub max_size: i32,
}

/// 배치 커밋 결과
#[wasm_bindgen(getter_with_clone)]
pub struct CommitResult {
    pub slot_id: usize,
    pub packet_ptr: usize,
    pub packet_len: usize,
}

/// 배치 처리 지원 Zero-Copy 풀
///
/// 여러 청크를 한 번에 처리하여 JS ↔ WASM 호출 오버헤드 감소
#[wasm_bindgen]
pub struct ZeroCopyBatchPool {
    inner: ZeroCopyPacketPool,
    pending_slots: Vec<usize>,
}

#[wasm_bindgen]
impl ZeroCopyBatchPool {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: ZeroCopyPacketPool::new(),
            pending_slots: Vec::with_capacity(16),
        }
    }

    /// 여러 슬롯 일괄 획득
    ///
    /// Returns: 획득한 슬롯 정보 배열 (flat: [slot_id, ptr, size, slot_id, ptr, size, ...])
    pub fn acquire_batch(&mut self, count: usize) -> Vec<i32> {
        let mut results = Vec::with_capacity(count * 3);

        for _ in 0..count {
            let slot_info = self.inner.acquire_slot();
            if slot_info[0] < 0 {
                break;
            }
            results.extend_from_slice(&slot_info);
            self.pending_slots.push(slot_info[0] as usize);
        }

        results
    }

    /// 여러 슬롯 일괄 커밋
    ///
    /// - data_lens: 각 슬롯의 데이터 길이 배열
    ///
    /// Returns: 커밋 결과 배열 (flat: [slot_id, ptr, len, slot_id, ptr, len, ...])
    pub fn commit_batch(&mut self, data_lens: &[usize]) -> Vec<usize> {
        let mut results = Vec::with_capacity(data_lens.len() * 3);

        for (i, &data_len) in data_lens.iter().enumerate() {
            if i >= self.pending_slots.len() {
                break;
            }

            let slot_id = self.pending_slots[i];
            let packet_len = self.inner.commit_slot(slot_id, data_len);

            if packet_len > 0 {
                let view = self.inner.get_packet_view(slot_id);
                results.push(slot_id);
                results.push(view[0]);
                results.push(view[1]);
            }
        }

        self.pending_slots.clear();
        results
    }

    /// 슬롯 반환
    pub fn release_slot(&mut self, slot_id: usize) {
        self.inner.release_slot(slot_id);
    }

    /// 여러 슬롯 일괄 반환
    pub fn release_batch(&mut self, slot_ids: &[usize]) {
        self.inner.release_slots(slot_ids);
    }

    /// 버퍼 포인터
    pub fn get_buffer_ptr(&self) -> *const u8 {
        self.inner.get_buffer_ptr()
    }

    /// 사용 가능한 슬롯 수
    pub fn available_slots(&self) -> usize {
        self.inner.available_slots()
    }

    /// 리셋
    pub fn reset(&mut self) {
        self.inner.reset();
        self.pending_slots.clear();
    }

    #[wasm_bindgen(getter)]
    pub fn sequence(&self) -> u32 {
        self.inner.sequence()
    }

    #[wasm_bindgen(getter)]
    pub fn total_bytes(&self) -> u64 {
        self.inner.total_bytes()
    }
}

impl Default for ZeroCopyBatchPool {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 테스트용: 슬롯 ID로부터 버퍼 내 데이터 오프셋 계산
    fn get_data_offset(slot_id: usize) -> usize {
        slot_id * SLOT_SIZE + MAX_HEADER_SIZE
    }

    #[test]
    fn test_acquire_commit_release() {
        let mut pool = ZeroCopyPacketPool::new();

        // 슬롯 획득
        let slot_info = pool.acquire_slot();
        assert!(slot_info[0] >= 0);
        let slot_id = slot_info[0] as usize;

        // 데이터 쓰기 시뮬레이션 (버퍼 내부 오프셋 사용)
        let test_data = b"Hello, Zero-Copy!";
        let data_offset = get_data_offset(slot_id);
        pool.buffer[data_offset..data_offset + test_data.len()].copy_from_slice(test_data);

        // 커밋
        let packet_len = pool.commit_slot(slot_id, test_data.len());
        assert_eq!(packet_len, STANDARD_HEADER_SIZE + test_data.len());

        // 패킷 뷰 획득
        let view = pool.get_packet_view(slot_id);
        assert_eq!(view[1], packet_len);

        // 슬롯 반환
        pool.release_slot(slot_id);
        assert_eq!(pool.available_slots(), POOL_SLOTS);
    }

    #[test]
    fn test_sequence_increment() {
        let mut pool = ZeroCopyPacketPool::new();

        for i in 0..5 {
            let slot_info = pool.acquire_slot();
            let slot_id = slot_info[0] as usize;
            let data_offset = get_data_offset(slot_id);

            pool.buffer[data_offset] = i as u8;
            pool.commit_slot(slot_id, 1);
            pool.release_slot(slot_id);
        }

        assert_eq!(pool.sequence(), 5);
        assert_eq!(pool.total_bytes(), 5);
    }

    #[test]
    fn test_pool_exhaustion() {
        let mut pool = ZeroCopyPacketPool::with_capacity(4);

        // 모든 슬롯 획득
        for _ in 0..4 {
            let slot_info = pool.acquire_slot();
            assert!(slot_info[0] >= 0);
        }

        // 풀 가득 참
        let slot_info = pool.acquire_slot();
        assert_eq!(slot_info[0], -1);

        assert_eq!(pool.available_slots(), 0);
    }

    #[test]
    fn test_batch_operations() {
        let mut pool = ZeroCopyBatchPool::new();

        // 배치 획득
        let slots = pool.acquire_batch(3);
        assert_eq!(slots.len(), 9); // 3 slots * 3 values

        // 데이터 쓰기 시뮬레이션
        let data_lens = vec![100, 200, 150];

        // 배치 커밋
        let results = pool.commit_batch(&data_lens);
        assert_eq!(results.len(), 9); // 3 results * 3 values

        // 배치 반환
        let slot_ids: Vec<usize> = results.iter().step_by(3).copied().collect();
        pool.release_batch(&slot_ids);

        assert_eq!(pool.available_slots(), 64);
    }

    #[test]
    fn test_crc_verification() {
        let mut pool = ZeroCopyPacketPool::new();

        let slot_info = pool.acquire_slot();
        let slot_id = slot_info[0] as usize;

        let test_data = b"CRC test data";
        let data_offset = get_data_offset(slot_id);
        pool.buffer[data_offset..data_offset + test_data.len()].copy_from_slice(test_data);

        pool.commit_slot(slot_id, test_data.len());

        // 헤더에서 CRC 추출
        let base_ptr = slot_id * SLOT_SIZE + (MAX_HEADER_SIZE - STANDARD_HEADER_SIZE);
        let stored_crc = u32::from_le_bytes([
            pool.buffer[base_ptr + 18],
            pool.buffer[base_ptr + 19],
            pool.buffer[base_ptr + 20],
            pool.buffer[base_ptr + 21],
        ]);

        // 직접 계산한 CRC와 비교
        let expected_crc = calculate_crc32(test_data);
        assert_eq!(stored_crc, expected_crc);
    }

    #[test]
    fn test_file_index_commit_uses_aligned_data_offset() {
        let mut pool = ZeroCopyPacketPool::new();

        let slot_info = pool.acquire_slot();
        let slot_id = slot_info[0] as usize;

        let test_data = b"file-index packet";
        let data_offset = get_data_offset(slot_id);
        pool.buffer[data_offset..data_offset + test_data.len()].copy_from_slice(test_data);

        let packet_len = pool.commit_slot_with_file_index(slot_id, test_data.len(), 7);
        assert_eq!(packet_len, STANDARD_HEADER_SIZE + test_data.len());

        let view = pool.get_packet_view(slot_id);
        let packet_offset = view[0] - pool.buffer.as_ptr() as usize;
        let packet = &pool.buffer[packet_offset..packet_offset + packet_len];

        assert_eq!(u16::from_le_bytes([packet[0], packet[1]]), 7);
        assert_eq!(&packet[STANDARD_HEADER_SIZE..], test_data);
    }

    #[test]
    fn test_encrypted_slot_roundtrip() {
        let mut pool = ZeroCopyPacketPool::new();
        let key = [7u8; 32];
        let prefix = [3u8; 8];
        let mut encrypt_session = CryptoSession::new(&key, &prefix).expect("encrypt session");
        let decrypt_session = CryptoSession::new(&key, &prefix).expect("decrypt session");

        let slot_info = pool.acquire_slot();
        let slot_id = slot_info[0] as usize;

        let test_data = b"encrypted zero-copy payload";
        let data_offset = get_data_offset(slot_id);
        pool.buffer[data_offset..data_offset + test_data.len()].copy_from_slice(test_data);

        let packet_len = pool.commit_encrypted_slot(slot_id, test_data.len(), &mut encrypt_session);
        assert_eq!(
            packet_len,
            ENCRYPTED_HEADER_SIZE_CONST + test_data.len() + AUTH_TAG_SIZE
        );

        let view = pool.get_packet_view(slot_id);
        let packet_offset = view[0] - pool.buffer.as_ptr() as usize;
        let packet = &pool.buffer[packet_offset..packet_offset + packet_len];

        assert_eq!(packet[0], CRYPTO_VERSION);
        assert_eq!(packet[1], flags::ENCRYPTED);
        assert_eq!(
            u32::from_le_bytes([packet[16], packet[17], packet[18], packet[19]]) as usize,
            test_data.len()
        );

        let decrypted = decrypt_session
            .decrypt_chunk(packet)
            .expect("decrypt encrypted zero-copy packet");
        assert_eq!(decrypted, test_data);
    }
}
