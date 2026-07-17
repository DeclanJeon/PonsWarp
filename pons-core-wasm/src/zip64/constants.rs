// ZIP 시그니처
pub const LOCAL_FILE_HEADER_SIGNATURE: u32 = 0x04034b50;
pub const DATA_DESCRIPTOR_SIGNATURE: u32 = 0x08074b50;
pub const CENTRAL_DIR_HEADER_SIGNATURE: u32 = 0x02014b50;
pub const EOCD_SIGNATURE: u32 = 0x06054b50;
pub const EOCD64_SIGNATURE: u32 = 0x06064b50;
pub const EOCD64_LOCATOR_SIGNATURE: u32 = 0x07064b50;

// ZIP64 Extra Field
pub const ZIP64_EXTRA_FIELD_ID: u16 = 0x0001;

// 압축 방식
pub const COMPRESSION_STORED: u16 = 0;
pub const COMPRESSION_DEFLATE: u16 = 8;

// 버전
pub const VERSION_NEEDED_ZIP64: u16 = 45; // ZIP64 requires version 4.5
pub const VERSION_MADE_BY: u16 = 45;

// 플래그
pub const FLAG_DATA_DESCRIPTOR: u16 = 0x0008;
pub const FLAG_UTF8: u16 = 0x0800;

// ZIP64 마커 값
pub const ZIP64_MARKER_32: u32 = 0xFFFFFFFF;
pub const ZIP64_MARKER_16: u16 = 0xFFFF;
