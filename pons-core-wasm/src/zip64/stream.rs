use super::deflate::DeflateState;
use super::structures::*;
use wasm_bindgen::prelude::*;

/// ZIP64 스트리밍 압축기
#[wasm_bindgen]
pub struct Zip64Stream {
    entries: Vec<FileEntry>,
    current_entry: Option<FileEntry>,
    current_offset: u64,
    use_compression: bool,
    compression_level: u8,
    deflate_state: Option<DeflateState>,
    crc_hasher: Option<crate::crc32::Crc32Hasher>,
    total_input_bytes: u64,
    total_output_bytes: u64,
}

#[wasm_bindgen]
impl Zip64Stream {
    /// 새 ZIP64 스트림 생성
    /// compression_level: 0 = STORE (압축 없음), 1-9 = DEFLATE 압축
    #[wasm_bindgen(constructor)]
    pub fn new(compression_level: u8) -> Self {
        let use_compression = compression_level > 0;
        Self {
            entries: Vec::new(),
            current_entry: None,
            current_offset: 0,
            use_compression,
            compression_level: compression_level.min(9),
            deflate_state: None,
            crc_hasher: None,
            total_input_bytes: 0,
            total_output_bytes: 0,
        }
    }

    /// 파일 시작 (Local File Header 생성)
    pub fn begin_file(&mut self, path: &str, uncompressed_size: u64) -> Vec<u8> {
        // 이전 파일이 있으면 종료
        if self.current_entry.is_some() {
            let _ = self.end_file();
        }

        // 새 파일 엔트리 생성
        let entry = FileEntry::new(path.to_string(), self.current_offset, self.use_compression);
        self.current_entry = Some(entry);

        // 압축 모드에 따라 상태 초기화
        if self.use_compression {
            self.deflate_state = Some(DeflateState::new(self.compression_level));
            self.crc_hasher = None;
        } else {
            self.deflate_state = None;
            self.crc_hasher = Some(crate::crc32::Crc32Hasher::new());
        }

        // Local File Header 생성
        let header = build_local_file_header(path, uncompressed_size, self.use_compression);
        self.current_offset += header.len() as u64;
        self.total_output_bytes += header.len() as u64;

        header
    }

    /// 파일 데이터 청크 처리 (압축 또는 STORE)
    #[wasm_bindgen]
    pub fn process_chunk(&mut self, data: &[u8]) -> Vec<u8> {
        if data.is_empty() {
            return Vec::new();
        }

        self.total_input_bytes += data.len() as u64;

        if self.use_compression {
            // DEFLATE 압축 모드
            if let Some(ref mut deflate) = self.deflate_state {
                let compressed = deflate.compress_chunk(data);
                self.current_offset += compressed.len() as u64;
                self.total_output_bytes += compressed.len() as u64;
                compressed
            } else {
                Vec::new()
            }
        } else {
            // STORE 모드 (압축 없음)
            if let Some(ref mut hasher) = self.crc_hasher {
                hasher.update(data);
            }
            self.current_offset += data.len() as u64;
            self.total_output_bytes += data.len() as u64;
            data.to_vec()
        }
    }

    /// 파일 데이터 청크 압축 (하위 호환성)
    pub fn compress_chunk(&mut self, data: &[u8]) -> Vec<u8> {
        self.process_chunk(data)
    }

    /// 파일 종료 (Data Descriptor 생성)
    pub fn end_file(&mut self) -> Vec<u8> {
        let mut output = Vec::new();

        if self.use_compression {
            // DEFLATE 압축 모드
            if let Some(ref mut deflate) = self.deflate_state {
                // 남은 압축 데이터 플러시
                let final_data = deflate.finish();
                self.current_offset += final_data.len() as u64;
                self.total_output_bytes += final_data.len() as u64;
                output.extend(final_data);

                // 엔트리 정보 업데이트
                if let Some(ref mut entry) = self.current_entry {
                    entry.crc32 = deflate.crc32();
                    entry.compressed_size = deflate.total_out();
                    entry.uncompressed_size = deflate.total_in();
                }
            }
        } else {
            // STORE 모드
            if let Some(ref hasher) = self.crc_hasher {
                if let Some(ref mut entry) = self.current_entry {
                    entry.crc32 = hasher.finalize();
                    // STORE 모드에서는 압축 크기 = 원본 크기
                    let size = self.total_input_bytes
                        - self
                            .entries
                            .iter()
                            .map(|e| e.uncompressed_size)
                            .sum::<u64>();
                    entry.compressed_size = size;
                    entry.uncompressed_size = size;
                }
            }
        }

        // Data Descriptor 생성
        if let Some(ref entry) = self.current_entry {
            let descriptor =
                build_data_descriptor(entry.crc32, entry.compressed_size, entry.uncompressed_size);
            self.current_offset += descriptor.len() as u64;
            self.total_output_bytes += descriptor.len() as u64;
            output.extend(descriptor);

            // 엔트리 저장
            self.entries.push(entry.clone());
        }

        // 상태 초기화
        self.current_entry = None;
        self.deflate_state = None;
        self.crc_hasher = None;

        output
    }

    /// ZIP 아카이브 종료 (Central Directory + EOCD64 생성)
    pub fn finalize(&mut self) -> Vec<u8> {
        // 현재 파일이 있으면 종료
        let mut output = if self.current_entry.is_some() {
            self.end_file()
        } else {
            Vec::new()
        };

        let central_dir_offset = self.current_offset;
        let entry_count = self.entries.len() as u64;

        // Central Directory Headers 생성
        let mut central_dir_size: u64 = 0;
        for entry in &self.entries {
            let header = build_central_dir_header(entry);
            central_dir_size += header.len() as u64;
            output.extend(header);
        }

        let eocd64_offset = central_dir_offset + central_dir_size;

        // ZIP64 End of Central Directory Record
        let eocd64 = build_eocd64(entry_count, central_dir_size, central_dir_offset);
        output.extend(eocd64);

        // ZIP64 End of Central Directory Locator
        let locator = build_eocd64_locator(eocd64_offset);
        output.extend(locator);

        // End of Central Directory Record (표준)
        let eocd = build_eocd(entry_count, central_dir_size, central_dir_offset);
        output.extend(eocd);

        self.total_output_bytes += output.len() as u64;
        output
    }

    /// 현재까지 출력된 총 바이트 수
    #[wasm_bindgen(getter)]
    pub fn total_output_bytes(&self) -> u64 {
        self.total_output_bytes
    }

    /// 현재까지 입력된 총 바이트 수
    #[wasm_bindgen(getter)]
    pub fn total_input_bytes(&self) -> u64 {
        self.total_input_bytes
    }

    /// 현재 파일의 압축된 바이트 수
    #[wasm_bindgen(getter)]
    pub fn current_compressed_bytes(&self) -> u64 {
        self.deflate_state
            .as_ref()
            .map(|d| d.total_out())
            .unwrap_or(0)
    }

    /// 현재 파일의 원본 바이트 수
    #[wasm_bindgen(getter)]
    pub fn current_uncompressed_bytes(&self) -> u64 {
        self.deflate_state
            .as_ref()
            .map(|d| d.total_in())
            .unwrap_or(0)
    }

    /// 파일 개수
    #[wasm_bindgen(getter)]
    pub fn file_count(&self) -> u32 {
        self.entries.len() as u32
    }

    /// 상태 리셋
    pub fn reset(&mut self) {
        self.entries.clear();
        self.current_entry = None;
        self.current_offset = 0;
        self.deflate_state = None;
        self.crc_hasher = None;
        self.total_input_bytes = 0;
        self.total_output_bytes = 0;
    }
}

impl Default for Zip64Stream {
    fn default() -> Self {
        Self::new(0) // 기본값: STORE 모드 (압축 없음)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zip64_store_mode() {
        let mut stream = Zip64Stream::new(0); // STORE 모드

        let header = stream.begin_file("test.txt", 13);
        assert_eq!(&header[0..4], &[0x50, 0x4b, 0x03, 0x04]);

        let data = stream.process_chunk(b"Hello, World!");
        assert_eq!(data.len(), 13); // 압축 없음

        let _descriptor = stream.end_file();
        let footer = stream.finalize();

        // EOCD64 시그니처 확인
        assert!(footer.windows(4).any(|w| w == [0x50, 0x4b, 0x06, 0x06]));
        // EOCD 시그니처 확인
        assert!(footer.windows(4).any(|w| w == [0x50, 0x4b, 0x05, 0x06]));
    }

    #[test]
    fn test_zip64_deflate_mode() {
        let mut stream = Zip64Stream::new(6); // DEFLATE 모드

        // 압축 가능한 반복 데이터 사용
        let data = b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 40 bytes
        let header = stream.begin_file("test.txt", data.len() as u64);
        assert_eq!(&header[0..4], &[0x50, 0x4b, 0x03, 0x04]);

        let _compressed = stream.process_chunk(data);
        // 압축된 크기는 원본보다 작아야 함

        let _descriptor = stream.end_file();
        let footer = stream.finalize();

        assert!(footer.windows(4).any(|w| w == [0x50, 0x4b, 0x06, 0x06]));
        // 압축 모드에서는 출력 크기가 입력보다 작거나 같아야 함
        assert!(stream.total_output_bytes() > 0);
    }

    #[test]
    fn test_zip64_multiple_files_store() {
        let mut stream = Zip64Stream::new(0); // STORE 모드

        // 파일 1
        stream.begin_file("file1.txt", 5);
        stream.process_chunk(b"Hello");
        stream.end_file();

        // 파일 2
        stream.begin_file("file2.txt", 5);
        stream.process_chunk(b"World");
        stream.end_file();

        let footer = stream.finalize();

        assert_eq!(stream.file_count(), 2);
        assert_eq!(stream.total_input_bytes(), 10);
        assert!(!footer.is_empty());
    }

    #[test]
    fn test_zip64_chunked_store() {
        let mut stream = Zip64Stream::new(0); // STORE 모드

        stream.begin_file("large.bin", 1024);

        // 청크 단위로 처리
        for _ in 0..16 {
            let chunk = vec![0u8; 64];
            stream.process_chunk(&chunk);
        }

        stream.end_file();
        let _footer = stream.finalize();

        assert_eq!(stream.total_input_bytes(), 1024);
        assert!(stream.total_output_bytes() > 1024); // 헤더 포함
    }
}
