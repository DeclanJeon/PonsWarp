use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

const SLOT_SIZE: usize = 64 * 1024; // 64KB per slot
const MAX_SLOTS: usize = 2048; // 128MB total capacity
const MAX_BUFFER_SIZE: usize = 128 * 1024 * 1024;

/// 슬롯 메타데이터
#[derive(Clone, Copy)]
struct SlotMeta {
    length: u32,
    timestamp: u32,
}

/// Arena 기반 메모리 풀
struct Arena {
    data: Vec<u8>,
    free_list: Vec<u16>,
    slot_meta: Vec<Option<SlotMeta>>,
}

impl Arena {
    fn new() -> Self {
        Self {
            data: vec![0u8; SLOT_SIZE * MAX_SLOTS],
            free_list: (0..MAX_SLOTS as u16).rev().collect(),
            slot_meta: vec![None; MAX_SLOTS],
        }
    }

    fn allocate(&mut self) -> Option<u16> {
        self.free_list.pop()
    }

    fn deallocate(&mut self, slot_idx: u16) {
        self.slot_meta[slot_idx as usize] = None;
        self.free_list.push(slot_idx);
    }

    fn write(&mut self, slot_idx: u16, data: &[u8], meta: SlotMeta) {
        let start = slot_idx as usize * SLOT_SIZE;
        let end = start + data.len();
        self.data[start..end].copy_from_slice(data);
        self.slot_meta[slot_idx as usize] = Some(meta);
    }

    fn read(&self, slot_idx: u16) -> Option<(&[u8], SlotMeta)> {
        let meta = self.slot_meta[slot_idx as usize]?;
        let start = slot_idx as usize * SLOT_SIZE;
        let end = start + meta.length as usize;
        Some((&self.data[start..end], meta))
    }

    fn clear(&mut self) {
        self.free_list = (0..MAX_SLOTS as u16).rev().collect();
        self.slot_meta.fill(None);
    }
}

/// WASM 기반 Reordering Buffer
///
/// 비순차적으로 도착하는 청크들을 순서대로 정렬하여 내보내는 버퍼.
/// GC 오버헤드 없이 Arena 기반 메모리 관리로 고속 처리.
#[wasm_bindgen]
pub struct WasmReorderingBuffer {
    arena: Arena,
    /// offset → slot_index 매핑 (정렬된 상태 유지)
    index: BTreeMap<u64, u16>,
    /// 다음 예상 오프셋
    next_expected: u64,
    /// 총 처리 바이트
    total_processed: u64,
    /// 현재 버퍼 사용량
    current_size: usize,
}

#[wasm_bindgen]
impl WasmReorderingBuffer {
    /// 생성자
    #[wasm_bindgen(constructor)]
    pub fn new(start_offset: u64) -> Self {
        Self {
            arena: Arena::new(),
            index: BTreeMap::new(),
            next_expected: start_offset,
            total_processed: 0,
            current_size: 0,
        }
    }

    /// 청크 삽입 및 순차 데이터 반환
    ///
    /// # Zero-Copy 전략
    /// 1. JS에서 WASM 메모리로 직접 복사 (1회)
    /// 2. 순차 청크는 즉시 반환 (복사 없음)
    /// 3. 비순차 청크는 Arena에 저장
    pub fn push(&mut self, chunk: &[u8], offset: u64) -> Option<Vec<u8>> {
        let chunk_len = chunk.len();

        // 이미 처리된 오프셋 무시
        if offset < self.next_expected {
            return None;
        }

        // 중복 청크 무시
        if self.index.contains_key(&offset) {
            return None;
        }

        // Fast Path: 정확히 기다리던 순서
        if offset == self.next_expected {
            self.advance(chunk_len);

            // 버퍼에서 연속 청크 drain
            let mut result = chunk.to_vec();
            self.drain_into(&mut result);

            return Some(result);
        }

        // Buffered Path: Arena에 저장
        self.store_chunk(chunk, offset);
        None
    }

    /// Arena에 청크 저장
    fn store_chunk(&mut self, chunk: &[u8], offset: u64) {
        // 청크가 슬롯 크기를 초과하면 무시 (설계상 64KB 제한)
        if chunk.len() > SLOT_SIZE {
            return;
        }

        // 버퍼 오버플로우 체크
        while self.current_size + chunk.len() > MAX_BUFFER_SIZE {
            if !self.evict_oldest() {
                return; // 더 이상 제거할 것이 없음
            }
        }

        // 슬롯 할당
        let slot_idx = match self.arena.allocate() {
            Some(idx) => idx,
            None => {
                // 슬롯 부족 시 가장 오래된 것 제거
                if !self.evict_oldest() {
                    return;
                }
                self.arena.allocate().unwrap()
            }
        };

        // 메타데이터 설정 및 데이터 복사
        let meta = SlotMeta {
            length: chunk.len() as u32,
            timestamp: Self::now(),
        };

        self.arena.write(slot_idx, chunk, meta);
        self.index.insert(offset, slot_idx);
        self.current_size += chunk.len();
    }

    /// 연속 청크 배출
    fn drain_into(&mut self, output: &mut Vec<u8>) {
        while let Some((&first_offset, _)) = self.index.first_key_value() {
            // BTreeMap의 첫 번째 항목 확인
            if first_offset != self.next_expected {
                break;
            }

            // 슬롯 인덱스 가져오기
            let slot_idx = *self.index.get(&first_offset).unwrap();

            if let Some((data, meta)) = self.arena.read(slot_idx) {
                output.extend_from_slice(data);

                // 슬롯 반환
                self.index.remove(&first_offset);
                self.arena.deallocate(slot_idx);
                self.current_size -= meta.length as usize;

                self.advance(meta.length as usize);
            } else {
                break;
            }
        }
    }

    /// 가장 오래된 청크 제거 (메모리 보호)
    fn evict_oldest(&mut self) -> bool {
        // timestamp 기준으로 가장 오래된 것 찾기
        let mut oldest: Option<(u64, u16, u32)> = None;

        for (&offset, &slot_idx) in &self.index {
            if let Some(meta) = self.arena.slot_meta[slot_idx as usize] {
                match oldest {
                    None => oldest = Some((offset, slot_idx, meta.timestamp)),
                    Some((_, _, ts)) if meta.timestamp < ts => {
                        oldest = Some((offset, slot_idx, meta.timestamp));
                    }
                    _ => {}
                }
            }
        }

        if let Some((offset, slot_idx, _)) = oldest {
            if let Some(meta) = self.arena.slot_meta[slot_idx as usize] {
                self.index.remove(&offset);
                self.arena.deallocate(slot_idx);
                self.current_size -= meta.length as usize;
                return true;
            }
        }

        false
    }

    fn advance(&mut self, len: usize) {
        self.next_expected += len as u64;
        self.total_processed += len as u64;
    }

    fn now() -> u32 {
        #[cfg(target_arch = "wasm32")]
        {
            js_sys::Date::now() as u32
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            0
        }
    }

    // === Getters ===

    #[wasm_bindgen(getter)]
    pub fn next_expected_offset(&self) -> u64 {
        self.next_expected
    }

    #[wasm_bindgen(getter)]
    pub fn pending_count(&self) -> usize {
        self.index.len()
    }

    #[wasm_bindgen(getter)]
    pub fn buffered_bytes(&self) -> usize {
        self.current_size
    }

    #[wasm_bindgen(getter)]
    pub fn total_processed(&self) -> u64 {
        self.total_processed
    }

    /// 리소스 정리
    pub fn clear(&mut self) {
        self.index.clear();
        self.arena.clear();
        self.next_expected = 0;
        self.total_processed = 0;
        self.current_size = 0;
    }

    /// 시작 오프셋 재설정
    pub fn reset(&mut self, start_offset: u64) {
        self.clear();
        self.next_expected = start_offset;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sequential_chunks() {
        let mut buffer = WasmReorderingBuffer::new(0);

        // 순차적으로 청크 추가
        let result1 = buffer.push(b"chunk1", 0);
        assert!(result1.is_some());
        assert_eq!(result1.unwrap(), b"chunk1");
        assert_eq!(buffer.next_expected_offset(), 6);

        let result2 = buffer.push(b"chunk2", 6);
        assert!(result2.is_some());
        assert_eq!(result2.unwrap(), b"chunk2");
        assert_eq!(buffer.next_expected_offset(), 12);
    }

    #[test]
    fn test_out_of_order_chunks() {
        let mut buffer = WasmReorderingBuffer::new(0);

        // 비순차적으로 청크 추가
        let result1 = buffer.push(b"chunk2", 6); // 먼저 두 번째 청크
        assert!(result1.is_none());
        assert_eq!(buffer.pending_count(), 1);

        let result2 = buffer.push(b"chunk1", 0); // 첫 번째 청크
        assert!(result2.is_some());
        // 두 청크가 합쳐져서 반환
        let data = result2.unwrap();
        assert_eq!(&data[..6], b"chunk1");
        assert_eq!(&data[6..], b"chunk2");
        assert_eq!(buffer.pending_count(), 0);
    }

    #[test]
    fn test_duplicate_chunk() {
        let mut buffer = WasmReorderingBuffer::new(0);

        buffer.push(b"chunk2", 6);
        let result = buffer.push(b"chunk2_dup", 6); // 중복
        assert!(result.is_none());
        assert_eq!(buffer.pending_count(), 1);
    }

    #[test]
    fn test_already_processed() {
        let mut buffer = WasmReorderingBuffer::new(0);

        buffer.push(b"chunk1", 0);
        let result = buffer.push(b"old_chunk", 0); // 이미 처리됨
        assert!(result.is_none());
    }

    #[test]
    fn test_clear() {
        let mut buffer = WasmReorderingBuffer::new(0);

        buffer.push(b"chunk2", 6);
        buffer.push(b"chunk3", 12);
        assert_eq!(buffer.pending_count(), 2);

        buffer.clear();
        assert_eq!(buffer.pending_count(), 0);
        assert_eq!(buffer.next_expected_offset(), 0);
        assert_eq!(buffer.buffered_bytes(), 0);
    }

    #[test]
    fn test_reset_with_offset() {
        let mut buffer = WasmReorderingBuffer::new(0);

        buffer.push(b"chunk1", 0);
        buffer.reset(100);

        assert_eq!(buffer.next_expected_offset(), 100);
        assert_eq!(buffer.pending_count(), 0);
    }

    #[test]
    fn test_multiple_out_of_order() {
        let mut buffer = WasmReorderingBuffer::new(0);

        // 역순으로 추가
        buffer.push(b"444", 9);
        buffer.push(b"333", 6);
        buffer.push(b"222", 3);

        assert_eq!(buffer.pending_count(), 3);

        // 첫 번째 청크 추가 시 모두 drain
        let result = buffer.push(b"111", 0);
        assert!(result.is_some());

        let data = result.unwrap();
        assert_eq!(data.len(), 12);
        assert_eq!(&data[0..3], b"111");
        assert_eq!(&data[3..6], b"222");
        assert_eq!(&data[6..9], b"333");
        assert_eq!(&data[9..12], b"444");

        assert_eq!(buffer.pending_count(), 0);
        assert_eq!(buffer.total_processed(), 12);
    }
}
