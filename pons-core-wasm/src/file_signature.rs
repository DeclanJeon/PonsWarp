//! 파일 시그니처 감지
//!
//! 파일 매직 바이트를 분석하여 MIME 타입을 정확하게 감지합니다.

use wasm_bindgen::prelude::*;

/// 파일 시그니처 정의
struct Signature {
    magic: &'static [u8],
    offset: usize,
    mime: &'static str,
    extension: &'static str,
}

const SIGNATURES: &[Signature] = &[
    // 이미지
    Signature {
        magic: b"\x89PNG\r\n\x1a\n",
        offset: 0,
        mime: "image/png",
        extension: "png",
    },
    Signature {
        magic: b"\xff\xd8\xff",
        offset: 0,
        mime: "image/jpeg",
        extension: "jpg",
    },
    Signature {
        magic: b"GIF87a",
        offset: 0,
        mime: "image/gif",
        extension: "gif",
    },
    Signature {
        magic: b"GIF89a",
        offset: 0,
        mime: "image/gif",
        extension: "gif",
    },
    Signature {
        magic: b"RIFF",
        offset: 0,
        mime: "image/webp",
        extension: "webp",
    },
    Signature {
        magic: b"BM",
        offset: 0,
        mime: "image/bmp",
        extension: "bmp",
    },
    Signature {
        magic: b"\x00\x00\x01\x00",
        offset: 0,
        mime: "image/x-icon",
        extension: "ico",
    },
    Signature {
        magic: b"II*\x00",
        offset: 0,
        mime: "image/tiff",
        extension: "tiff",
    },
    Signature {
        magic: b"MM\x00*",
        offset: 0,
        mime: "image/tiff",
        extension: "tiff",
    },
    // 비디오
    Signature {
        magic: b"\x00\x00\x00\x1cftyp",
        offset: 0,
        mime: "video/mp4",
        extension: "mp4",
    },
    Signature {
        magic: b"\x00\x00\x00\x20ftyp",
        offset: 0,
        mime: "video/mp4",
        extension: "mp4",
    },
    Signature {
        magic: b"ftyp",
        offset: 4,
        mime: "video/mp4",
        extension: "mp4",
    },
    Signature {
        magic: b"\x1aE\xdf\xa3",
        offset: 0,
        mime: "video/webm",
        extension: "webm",
    },
    Signature {
        magic: b"\x00\x00\x00\x14ftypqt",
        offset: 0,
        mime: "video/quicktime",
        extension: "mov",
    },
    Signature {
        magic: b"FLV\x01",
        offset: 0,
        mime: "video/x-flv",
        extension: "flv",
    },
    // 오디오
    Signature {
        magic: b"ID3",
        offset: 0,
        mime: "audio/mpeg",
        extension: "mp3",
    },
    Signature {
        magic: b"\xff\xfb",
        offset: 0,
        mime: "audio/mpeg",
        extension: "mp3",
    },
    Signature {
        magic: b"\xff\xfa",
        offset: 0,
        mime: "audio/mpeg",
        extension: "mp3",
    },
    Signature {
        magic: b"OggS",
        offset: 0,
        mime: "audio/ogg",
        extension: "ogg",
    },
    Signature {
        magic: b"fLaC",
        offset: 0,
        mime: "audio/flac",
        extension: "flac",
    },
    Signature {
        magic: b"FORM",
        offset: 0,
        mime: "audio/aiff",
        extension: "aiff",
    },
    // 압축 파일
    Signature {
        magic: b"PK\x03\x04",
        offset: 0,
        mime: "application/zip",
        extension: "zip",
    },
    Signature {
        magic: b"PK\x05\x06",
        offset: 0,
        mime: "application/zip",
        extension: "zip",
    },
    Signature {
        magic: b"Rar!\x1a\x07",
        offset: 0,
        mime: "application/x-rar-compressed",
        extension: "rar",
    },
    Signature {
        magic: b"\x1f\x8b\x08",
        offset: 0,
        mime: "application/gzip",
        extension: "gz",
    },
    Signature {
        magic: b"BZh",
        offset: 0,
        mime: "application/x-bzip2",
        extension: "bz2",
    },
    Signature {
        magic: b"\xfd7zXZ\x00",
        offset: 0,
        mime: "application/x-xz",
        extension: "xz",
    },
    Signature {
        magic: b"7z\xbc\xaf'\x1c",
        offset: 0,
        mime: "application/x-7z-compressed",
        extension: "7z",
    },
    Signature {
        magic: b"\x28\xb5\x2f\xfd",
        offset: 0,
        mime: "application/zstd",
        extension: "zst",
    },
    // 문서
    Signature {
        magic: b"%PDF",
        offset: 0,
        mime: "application/pdf",
        extension: "pdf",
    },
    Signature {
        magic: b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",
        offset: 0,
        mime: "application/msword",
        extension: "doc",
    },
    Signature {
        magic: b"{\rtf",
        offset: 0,
        mime: "application/rtf",
        extension: "rtf",
    },
    // 실행 파일
    Signature {
        magic: b"MZ",
        offset: 0,
        mime: "application/x-msdownload",
        extension: "exe",
    },
    Signature {
        magic: b"\x7fELF",
        offset: 0,
        mime: "application/x-executable",
        extension: "elf",
    },
    Signature {
        magic: b"\xca\xfe\xba\xbe",
        offset: 0,
        mime: "application/x-mach-binary",
        extension: "macho",
    },
    // 웹
    Signature {
        magic: b"<!DOCTYPE html",
        offset: 0,
        mime: "text/html",
        extension: "html",
    },
    Signature {
        magic: b"<html",
        offset: 0,
        mime: "text/html",
        extension: "html",
    },
    Signature {
        magic: b"<?xml",
        offset: 0,
        mime: "application/xml",
        extension: "xml",
    },
    Signature {
        magic: b"<svg",
        offset: 0,
        mime: "image/svg+xml",
        extension: "svg",
    },
    // 폰트
    Signature {
        magic: b"wOFF",
        offset: 0,
        mime: "font/woff",
        extension: "woff",
    },
    Signature {
        magic: b"wOF2",
        offset: 0,
        mime: "font/woff2",
        extension: "woff2",
    },
    Signature {
        magic: b"\x00\x01\x00\x00",
        offset: 0,
        mime: "font/ttf",
        extension: "ttf",
    },
    Signature {
        magic: b"OTTO",
        offset: 0,
        mime: "font/otf",
        extension: "otf",
    },
    // 데이터
    Signature {
        magic: b"SQLite format 3",
        offset: 0,
        mime: "application/x-sqlite3",
        extension: "sqlite",
    },
    // WASM
    Signature {
        magic: b"\x00asm",
        offset: 0,
        mime: "application/wasm",
        extension: "wasm",
    },
];

/// 파일 타입 감지 결과
#[wasm_bindgen(getter_with_clone)]
pub struct FileTypeResult {
    pub mime: String,
    pub extension: String,
    pub confidence: f32,
}

#[wasm_bindgen]
impl FileTypeResult {
    #[wasm_bindgen(constructor)]
    pub fn new(mime: &str, extension: &str, confidence: f32) -> Self {
        Self {
            mime: mime.to_string(),
            extension: extension.to_string(),
            confidence,
        }
    }
}

/// 파일 시그니처 감지기
#[wasm_bindgen]
pub struct FileSignatureDetector;

#[wasm_bindgen]
impl FileSignatureDetector {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    /// 파일 데이터에서 타입 감지
    pub fn detect(&self, data: &[u8]) -> FileTypeResult {
        if data.is_empty() {
            return FileTypeResult::new("application/octet-stream", "bin", 0.0);
        }

        // 시그니처 매칭
        for sig in SIGNATURES {
            if data.len() >= sig.offset + sig.magic.len() {
                let slice = &data[sig.offset..sig.offset + sig.magic.len()];
                if slice == sig.magic {
                    return FileTypeResult::new(sig.mime, sig.extension, 1.0);
                }
            }
        }

        // WEBP 특수 처리 (RIFF + WEBP)
        if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
            return FileTypeResult::new("image/webp", "webp", 1.0);
        }

        // WAV 특수 처리 (RIFF + WAVE)
        if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WAVE" {
            return FileTypeResult::new("audio/wav", "wav", 1.0);
        }

        // AVI 특수 처리 (RIFF + AVI)
        if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..11] == b"AVI" {
            return FileTypeResult::new("video/x-msvideo", "avi", 1.0);
        }

        // 텍스트 파일 휴리스틱
        if self.is_likely_text(data) {
            // JSON 감지
            let trimmed = self.trim_whitespace(data);
            if !trimmed.is_empty() && (trimmed[0] == b'{' || trimmed[0] == b'[') {
                return FileTypeResult::new("application/json", "json", 0.8);
            }
            return FileTypeResult::new("text/plain", "txt", 0.6);
        }

        FileTypeResult::new("application/octet-stream", "bin", 0.1)
    }

    /// 텍스트 파일 여부 휴리스틱
    fn is_likely_text(&self, data: &[u8]) -> bool {
        let sample_size = data.len().min(512);
        let sample = &data[..sample_size];

        let mut control = 0;

        for &byte in sample {
            match byte {
                0x09 | 0x0a | 0x0d | 0x20..=0x7e => {} // printable
                0x00 => return false,                  // NULL 바이트 = 바이너리
                0x01..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f => control += 1,
                0x80..=0xff => {} // UTF-8 멀티바이트
                _ => {}
            }
        }

        // 제어 문자가 5% 미만이면 텍스트로 간주
        control * 20 < sample_size
    }

    fn trim_whitespace<'a>(&self, data: &'a [u8]) -> &'a [u8] {
        let start = data
            .iter()
            .position(|&b| !b.is_ascii_whitespace())
            .unwrap_or(data.len());
        &data[start..]
    }
}

impl Default for FileSignatureDetector {
    fn default() -> Self {
        Self::new()
    }
}

/// 빠른 MIME 타입 감지
#[wasm_bindgen]
pub fn detect_mime_type(data: &[u8]) -> String {
    FileSignatureDetector::new().detect(data).mime
}

/// 빠른 확장자 감지
#[wasm_bindgen]
pub fn detect_extension(data: &[u8]) -> String {
    FileSignatureDetector::new().detect(data).extension
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_png_detection() {
        let png_header = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
        let result = FileSignatureDetector::new().detect(png_header);
        assert_eq!(result.mime, "image/png");
        assert_eq!(result.extension, "png");
    }

    #[test]
    fn test_jpeg_detection() {
        let jpeg_header = b"\xff\xd8\xff\xe0\x00\x10JFIF";
        let result = FileSignatureDetector::new().detect(jpeg_header);
        assert_eq!(result.mime, "image/jpeg");
    }

    #[test]
    fn test_pdf_detection() {
        let pdf_header = b"%PDF-1.4\n";
        let result = FileSignatureDetector::new().detect(pdf_header);
        assert_eq!(result.mime, "application/pdf");
    }

    #[test]
    fn test_zip_detection() {
        let zip_header = b"PK\x03\x04\x14\x00\x00\x00";
        let result = FileSignatureDetector::new().detect(zip_header);
        assert_eq!(result.mime, "application/zip");
    }

    #[test]
    fn test_text_detection() {
        let text = b"Hello, World!\nThis is a text file.";
        let result = FileSignatureDetector::new().detect(text);
        assert_eq!(result.mime, "text/plain");
    }

    #[test]
    fn test_json_detection() {
        let json = b"  {\"key\": \"value\"}";
        let result = FileSignatureDetector::new().detect(json);
        assert_eq!(result.mime, "application/json");
    }

    #[test]
    fn test_binary_detection() {
        let binary = b"\x00\x01\x02\x03\x04\x05";
        let result = FileSignatureDetector::new().detect(binary);
        assert_eq!(result.mime, "application/octet-stream");
    }
}
