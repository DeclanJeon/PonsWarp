use crate::crc32::calculate_crc32;
use wasm_bindgen::prelude::*;

const HEADER_SIZE: usize = 22;

#[wasm_bindgen(getter_with_clone)]
pub struct PacketHeader {
    pub file_index: u16,
    pub chunk_index: u32,
    pub offset: u64,
    pub length: u32,
    pub checksum: u32,
}

#[wasm_bindgen]
pub struct PacketEncoder {
    sequence: u32,
    total_bytes_sent: u64,
}

#[wasm_bindgen]
impl PacketEncoder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            sequence: 0,
            total_bytes_sent: 0,
        }
    }

    pub fn encode(&mut self, data: &[u8]) -> Vec<u8> {
        let data_len = data.len() as u32;
        let checksum = calculate_crc32(data);

        let mut packet = vec![0u8; HEADER_SIZE + data.len()];

        // Header: Little Endian
        // [0-1] FileIndex (u16)
        packet[0..2].copy_from_slice(&0u16.to_le_bytes());
        // [2-5] ChunkIndex (u32)
        packet[2..6].copy_from_slice(&self.sequence.to_le_bytes());
        // [6-13] Offset (u64)
        packet[6..14].copy_from_slice(&self.total_bytes_sent.to_le_bytes());
        // [14-17] Length (u32)
        packet[14..18].copy_from_slice(&data_len.to_le_bytes());
        // [18-21] Checksum (u32)
        packet[18..22].copy_from_slice(&checksum.to_le_bytes());
        // [22..] Data
        packet[HEADER_SIZE..].copy_from_slice(data);

        self.sequence += 1;
        self.total_bytes_sent += data_len as u64;

        packet
    }

    pub fn encode_with_file_index(&mut self, data: &[u8], file_index: u16) -> Vec<u8> {
        let data_len = data.len() as u32;
        let checksum = calculate_crc32(data);

        let mut packet = vec![0u8; HEADER_SIZE + data.len()];

        packet[0..2].copy_from_slice(&file_index.to_le_bytes());
        packet[2..6].copy_from_slice(&self.sequence.to_le_bytes());
        packet[6..14].copy_from_slice(&self.total_bytes_sent.to_le_bytes());
        packet[14..18].copy_from_slice(&data_len.to_le_bytes());
        packet[18..22].copy_from_slice(&checksum.to_le_bytes());
        packet[HEADER_SIZE..].copy_from_slice(data);

        self.sequence += 1;
        self.total_bytes_sent += data_len as u64;

        packet
    }

    #[wasm_bindgen(getter)]
    pub fn sequence(&self) -> u32 {
        self.sequence
    }

    #[wasm_bindgen(getter)]
    pub fn total_bytes_sent(&self) -> u64 {
        self.total_bytes_sent
    }

    pub fn reset(&mut self) {
        self.sequence = 0;
        self.total_bytes_sent = 0;
    }
}

impl Default for PacketEncoder {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
pub struct PacketDecoder;

#[wasm_bindgen]
impl PacketDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self
    }

    pub fn parse_header(packet: &[u8]) -> Option<PacketHeader> {
        if packet.len() < HEADER_SIZE {
            return None;
        }

        Some(PacketHeader {
            file_index: u16::from_le_bytes([packet[0], packet[1]]),
            chunk_index: u32::from_le_bytes([packet[2], packet[3], packet[4], packet[5]]),
            offset: u64::from_le_bytes([
                packet[6], packet[7], packet[8], packet[9], packet[10], packet[11], packet[12],
                packet[13],
            ]),
            length: u32::from_le_bytes([packet[14], packet[15], packet[16], packet[17]]),
            checksum: u32::from_le_bytes([packet[18], packet[19], packet[20], packet[21]]),
        })
    }

    pub fn verify(packet: &[u8]) -> bool {
        if packet.len() < HEADER_SIZE {
            return false;
        }

        let length = u32::from_le_bytes([packet[14], packet[15], packet[16], packet[17]]) as usize;
        let expected_checksum =
            u32::from_le_bytes([packet[18], packet[19], packet[20], packet[21]]);

        if packet.len() != HEADER_SIZE + length {
            return false;
        }

        let data = &packet[HEADER_SIZE..];
        let actual_checksum = calculate_crc32(data);

        expected_checksum == actual_checksum
    }

    pub fn extract_data(packet: &[u8]) -> Vec<u8> {
        if packet.len() <= HEADER_SIZE {
            return Vec::new();
        }
        packet[HEADER_SIZE..].to_vec()
    }

    pub fn is_eos(packet: &[u8]) -> bool {
        if packet.len() < 2 {
            return false;
        }
        u16::from_le_bytes([packet[0], packet[1]]) == 0xFFFF
    }
}

impl Default for PacketDecoder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_decode_roundtrip() {
        let mut encoder = PacketEncoder::new();
        let data = b"Hello, PonsWarp!";

        let packet = encoder.encode(data);

        assert!(PacketDecoder::verify(&packet));

        let header = PacketDecoder::parse_header(&packet).unwrap();
        assert_eq!(header.file_index, 0);
        assert_eq!(header.chunk_index, 0);
        assert_eq!(header.offset, 0);
        assert_eq!(header.length, data.len() as u32);

        let extracted = PacketDecoder::extract_data(&packet);
        assert_eq!(extracted, data);
    }

    #[test]
    fn test_sequence_increment() {
        let mut encoder = PacketEncoder::new();

        encoder.encode(b"chunk1");
        assert_eq!(encoder.sequence(), 1);

        encoder.encode(b"chunk2");
        assert_eq!(encoder.sequence(), 2);
    }

    #[test]
    fn test_corrupted_packet() {
        let mut encoder = PacketEncoder::new();
        let mut packet = encoder.encode(b"test data");

        // Corrupt the data
        packet[HEADER_SIZE] ^= 0xFF;

        assert!(!PacketDecoder::verify(&packet));
    }
}
