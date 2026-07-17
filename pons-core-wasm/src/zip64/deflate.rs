use crate::crc32::Crc32Hasher;
use miniz_oxide::deflate::core::{
    compress, create_comp_flags_from_zip_params, CompressorOxide, TDEFLFlush, TDEFLStatus,
};

/// DEFLATE 압축 상태 관리
pub struct DeflateState {
    compressor: CompressorOxide,
    crc_hasher: Crc32Hasher,
    total_in: u64,
    total_out: u64,
    output_buffer: Vec<u8>,
}

impl DeflateState {
    pub fn new(level: u8) -> Self {
        let level = level.min(9);
        let flags = create_comp_flags_from_zip_params(level as i32, -15, 0);

        Self {
            compressor: CompressorOxide::new(flags),
            crc_hasher: Crc32Hasher::new(),
            total_in: 0,
            total_out: 0,
            output_buffer: Vec::with_capacity(128 * 1024),
        }
    }

    /// 청크 압축 (스트리밍)
    pub fn compress_chunk(&mut self, input: &[u8]) -> Vec<u8> {
        if input.is_empty() {
            return Vec::new();
        }

        // CRC32 업데이트
        self.crc_hasher.update(input);
        self.total_in += input.len() as u64;

        // 출력 버퍼 준비 (입력 크기 + 여유)
        self.output_buffer.clear();
        self.output_buffer.resize(input.len() + 1024, 0);

        let mut in_pos = 0;
        let mut out_pos = 0;

        while in_pos < input.len() {
            // 버퍼 확장 필요시
            if out_pos >= self.output_buffer.len() - 512 {
                self.output_buffer
                    .resize(self.output_buffer.len() + 32 * 1024, 0);
            }

            let (status, bytes_in, bytes_out) = compress(
                &mut self.compressor,
                &input[in_pos..],
                &mut self.output_buffer[out_pos..],
                TDEFLFlush::Sync, // Sync flush로 즉시 출력
            );

            in_pos += bytes_in;
            out_pos += bytes_out;

            match status {
                TDEFLStatus::Okay | TDEFLStatus::Done => {}
                TDEFLStatus::BadParam | TDEFLStatus::PutBufFailed => {
                    // 버퍼 확장 후 재시도
                    self.output_buffer.resize(self.output_buffer.len() * 2, 0);
                }
            }
        }

        self.total_out += out_pos as u64;
        self.output_buffer.truncate(out_pos);
        self.output_buffer.clone()
    }

    /// 압축 종료 (남은 데이터 플러시)
    pub fn finish(&mut self) -> Vec<u8> {
        self.output_buffer.clear();
        self.output_buffer.resize(1024, 0);

        let mut out_pos = 0;

        loop {
            if out_pos >= self.output_buffer.len() - 512 {
                self.output_buffer
                    .resize(self.output_buffer.len() + 4096, 0);
            }

            let (status, _, bytes_out) = compress(
                &mut self.compressor,
                &[],
                &mut self.output_buffer[out_pos..],
                TDEFLFlush::Finish,
            );

            out_pos += bytes_out;

            match status {
                TDEFLStatus::Done => break,
                TDEFLStatus::Okay => continue,
                _ => break,
            }
        }

        self.total_out += out_pos as u64;
        self.output_buffer.truncate(out_pos);
        self.output_buffer.clone()
    }

    pub fn crc32(&self) -> u32 {
        self.crc_hasher.finalize()
    }

    pub fn total_in(&self) -> u64 {
        self.total_in
    }

    pub fn total_out(&self) -> u64 {
        self.total_out
    }
}
