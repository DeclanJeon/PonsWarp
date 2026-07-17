use super::constants::*;

/// 파일 엔트리 메타데이터 (Central Directory 생성용)
#[derive(Clone)]
pub struct FileEntry {
    pub path: String,
    pub local_header_offset: u64,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub crc32: u32,
    pub compression_method: u16,
    pub last_mod_time: u16,
    pub last_mod_date: u16,
}

impl FileEntry {
    pub fn new(path: String, offset: u64, use_compression: bool) -> Self {
        let (time, date) = get_dos_datetime();
        Self {
            path,
            local_header_offset: offset,
            compressed_size: 0,
            uncompressed_size: 0,
            crc32: 0,
            compression_method: if use_compression {
                COMPRESSION_DEFLATE
            } else {
                COMPRESSION_STORED
            },
            last_mod_time: time,
            last_mod_date: date,
        }
    }
}

/// DOS 날짜/시간 생성 (현재 시간 기준)
fn get_dos_datetime() -> (u16, u16) {
    // 고정값 사용 (2024-12-05 12:00:00)
    // 실제로는 js_sys::Date를 사용할 수 있지만 단순화
    let time: u16 = 12 << 11; // 12:00:00
    let date: u16 = ((2024 - 1980) << 9) | (12 << 5) | 5; // 2024-12-05
    (time, date)
}

/// Local File Header 생성 (ZIP64)
pub fn build_local_file_header(
    path: &str,
    uncompressed_size: u64,
    use_compression: bool,
) -> Vec<u8> {
    let path_bytes = path.as_bytes();
    let path_len = path_bytes.len() as u16;

    // ZIP64 Extra Field (uncompressed_size + compressed_size)
    let extra_field_data_size: u16 = 16; // 8 + 8 bytes
    let extra_field_size: u16 = 4 + extra_field_data_size; // header(4) + data

    let header_size = 30 + path_len as usize + extra_field_size as usize;
    let mut buf = vec![0u8; header_size];

    let (time, date) = get_dos_datetime();
    let compression_method = if use_compression {
        COMPRESSION_DEFLATE
    } else {
        COMPRESSION_STORED
    };

    // Local File Header
    write_u32_le(&mut buf, 0, LOCAL_FILE_HEADER_SIGNATURE);
    write_u16_le(&mut buf, 4, VERSION_NEEDED_ZIP64);
    write_u16_le(&mut buf, 6, FLAG_DATA_DESCRIPTOR | FLAG_UTF8);
    write_u16_le(&mut buf, 8, compression_method);
    write_u16_le(&mut buf, 10, time);
    write_u16_le(&mut buf, 12, date);
    write_u32_le(&mut buf, 14, 0); // CRC32 (Data Descriptor에서 설정)
    write_u32_le(&mut buf, 18, ZIP64_MARKER_32); // Compressed size (ZIP64)
    write_u32_le(&mut buf, 22, ZIP64_MARKER_32); // Uncompressed size (ZIP64)
    write_u16_le(&mut buf, 26, path_len);
    write_u16_le(&mut buf, 28, extra_field_size);

    // Filename
    buf[30..30 + path_len as usize].copy_from_slice(path_bytes);

    // ZIP64 Extra Field
    let extra_offset = 30 + path_len as usize;
    write_u16_le(&mut buf, extra_offset, ZIP64_EXTRA_FIELD_ID);
    write_u16_le(&mut buf, extra_offset + 2, extra_field_data_size);
    write_u64_le(&mut buf, extra_offset + 4, uncompressed_size);
    write_u64_le(&mut buf, extra_offset + 12, 0); // Compressed size (unknown yet)

    buf
}

/// ZIP64 Data Descriptor 생성
pub fn build_data_descriptor(crc32: u32, compressed_size: u64, uncompressed_size: u64) -> Vec<u8> {
    let mut buf = vec![0u8; 24];

    write_u32_le(&mut buf, 0, DATA_DESCRIPTOR_SIGNATURE);
    write_u32_le(&mut buf, 4, crc32);
    write_u64_le(&mut buf, 8, compressed_size);
    write_u64_le(&mut buf, 16, uncompressed_size);

    buf
}

/// Central Directory Header 생성 (ZIP64)
pub fn build_central_dir_header(entry: &FileEntry) -> Vec<u8> {
    let path_bytes = entry.path.as_bytes();
    let path_len = path_bytes.len() as u16;

    // ZIP64 Extra Field (uncompressed + compressed + offset)
    let extra_field_data_size: u16 = 24; // 8 + 8 + 8 bytes
    let extra_field_size: u16 = 4 + extra_field_data_size;

    let header_size = 46 + path_len as usize + extra_field_size as usize;
    let mut buf = vec![0u8; header_size];

    write_u32_le(&mut buf, 0, CENTRAL_DIR_HEADER_SIGNATURE);
    write_u16_le(&mut buf, 4, VERSION_MADE_BY);
    write_u16_le(&mut buf, 6, VERSION_NEEDED_ZIP64);
    write_u16_le(&mut buf, 8, FLAG_DATA_DESCRIPTOR | FLAG_UTF8);
    write_u16_le(&mut buf, 10, entry.compression_method);
    write_u16_le(&mut buf, 12, entry.last_mod_time);
    write_u16_le(&mut buf, 14, entry.last_mod_date);
    write_u32_le(&mut buf, 16, entry.crc32);
    write_u32_le(&mut buf, 20, ZIP64_MARKER_32); // Compressed size (ZIP64)
    write_u32_le(&mut buf, 24, ZIP64_MARKER_32); // Uncompressed size (ZIP64)
    write_u16_le(&mut buf, 28, path_len);
    write_u16_le(&mut buf, 30, extra_field_size);
    write_u16_le(&mut buf, 32, 0); // Comment length
    write_u16_le(&mut buf, 34, 0); // Disk number start
    write_u16_le(&mut buf, 36, 0); // Internal file attributes
    write_u32_le(&mut buf, 38, 0); // External file attributes
    write_u32_le(&mut buf, 42, ZIP64_MARKER_32); // Local header offset (ZIP64)

    // Filename
    buf[46..46 + path_len as usize].copy_from_slice(path_bytes);

    // ZIP64 Extra Field
    let extra_offset = 46 + path_len as usize;
    write_u16_le(&mut buf, extra_offset, ZIP64_EXTRA_FIELD_ID);
    write_u16_le(&mut buf, extra_offset + 2, extra_field_data_size);
    write_u64_le(&mut buf, extra_offset + 4, entry.uncompressed_size);
    write_u64_le(&mut buf, extra_offset + 12, entry.compressed_size);
    write_u64_le(&mut buf, extra_offset + 20, entry.local_header_offset);

    buf
}

/// ZIP64 End of Central Directory Record
pub fn build_eocd64(entry_count: u64, central_dir_size: u64, central_dir_offset: u64) -> Vec<u8> {
    let mut buf = vec![0u8; 56];

    write_u32_le(&mut buf, 0, EOCD64_SIGNATURE);
    write_u64_le(&mut buf, 4, 44); // Size of EOCD64 (excluding signature and this field)
    write_u16_le(&mut buf, 12, VERSION_MADE_BY);
    write_u16_le(&mut buf, 14, VERSION_NEEDED_ZIP64);
    write_u32_le(&mut buf, 16, 0); // Disk number
    write_u32_le(&mut buf, 20, 0); // Disk with central directory
    write_u64_le(&mut buf, 24, entry_count); // Entries on this disk
    write_u64_le(&mut buf, 32, entry_count); // Total entries
    write_u64_le(&mut buf, 40, central_dir_size);
    write_u64_le(&mut buf, 48, central_dir_offset);

    buf
}

/// ZIP64 End of Central Directory Locator
pub fn build_eocd64_locator(eocd64_offset: u64) -> Vec<u8> {
    let mut buf = vec![0u8; 20];

    write_u32_le(&mut buf, 0, EOCD64_LOCATOR_SIGNATURE);
    write_u32_le(&mut buf, 4, 0); // Disk with EOCD64
    write_u64_le(&mut buf, 8, eocd64_offset);
    write_u32_le(&mut buf, 16, 1); // Total disks

    buf
}

/// End of Central Directory Record (표준)
pub fn build_eocd(entry_count: u64, central_dir_size: u64, central_dir_offset: u64) -> Vec<u8> {
    let mut buf = vec![0u8; 22];

    // ZIP64인 경우 마커 값 사용
    let count_16 = if entry_count > 0xFFFF {
        ZIP64_MARKER_16
    } else {
        entry_count as u16
    };
    let size_32 = if central_dir_size > 0xFFFFFFFF {
        ZIP64_MARKER_32
    } else {
        central_dir_size as u32
    };
    let offset_32 = if central_dir_offset > 0xFFFFFFFF {
        ZIP64_MARKER_32
    } else {
        central_dir_offset as u32
    };

    write_u32_le(&mut buf, 0, EOCD_SIGNATURE);
    write_u16_le(&mut buf, 4, 0); // Disk number
    write_u16_le(&mut buf, 6, 0); // Disk with central directory
    write_u16_le(&mut buf, 8, count_16); // Entries on this disk
    write_u16_le(&mut buf, 10, count_16); // Total entries
    write_u32_le(&mut buf, 12, size_32);
    write_u32_le(&mut buf, 16, offset_32);
    write_u16_le(&mut buf, 20, 0); // Comment length

    buf
}

// Little-endian 헬퍼 함수들
fn write_u16_le(buf: &mut [u8], offset: usize, value: u16) {
    buf[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32_le(buf: &mut [u8], offset: usize, value: u32) {
    buf[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u64_le(buf: &mut [u8], offset: usize, value: u64) {
    buf[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}
#[cfg(test)]
mod tests {
    use super::*;

    fn read_u64_le(buf: &[u8], offset: usize) -> u64 {
        u64::from_le_bytes(buf[offset..offset + 8].try_into().unwrap())
    }

    #[test]
    fn encodes_four_gib_plus_one_without_truncation() {
        let boundary = 4_294_967_297u64;
        let local = build_local_file_header("x", boundary, false);
        assert_eq!(read_u64_le(&local, 35), boundary);

        let mut entry = FileEntry::new("x".to_owned(), boundary, false);
        entry.uncompressed_size = boundary;
        entry.compressed_size = boundary;
        let central = build_central_dir_header(&entry);
        assert_eq!(read_u64_le(&central, 51), boundary);
        assert_eq!(read_u64_le(&central, 59), boundary);
        assert_eq!(read_u64_le(&central, 67), boundary);

        let descriptor = build_data_descriptor(0, boundary, boundary);
        assert_eq!(read_u64_le(&descriptor, 8), boundary);
        assert_eq!(read_u64_le(&descriptor, 16), boundary);

        let eocd = build_eocd64(1, boundary, boundary);
        assert_eq!(read_u64_le(&eocd, 40), boundary);
        assert_eq!(read_u64_le(&eocd, 48), boundary);
        let locator = build_eocd64_locator(boundary);
        assert_eq!(read_u64_le(&locator, 8), boundary);
    }
}
