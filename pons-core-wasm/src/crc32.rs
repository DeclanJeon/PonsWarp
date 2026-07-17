use wasm_bindgen::prelude::*;

const CRC32_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut j = 0;
        while j < 8 {
            crc = if crc & 1 != 0 {
                0xEDB88320 ^ (crc >> 1)
            } else {
                crc >> 1
            };
            j += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
};

#[wasm_bindgen]
pub fn calculate_crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFFFFFF_u32;
    for &byte in data {
        crc = CRC32_TABLE[((crc ^ byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFFFFFF
}

#[wasm_bindgen]
pub struct Crc32Hasher {
    state: u32,
}

#[wasm_bindgen]
impl Crc32Hasher {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { state: 0xFFFFFFFF }
    }

    pub fn update(&mut self, data: &[u8]) {
        for &byte in data {
            self.state =
                CRC32_TABLE[((self.state ^ byte as u32) & 0xFF) as usize] ^ (self.state >> 8);
        }
    }

    pub fn finalize(&self) -> u32 {
        self.state ^ 0xFFFFFFFF
    }

    pub fn reset(&mut self) {
        self.state = 0xFFFFFFFF;
    }
}

impl Default for Crc32Hasher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crc32_empty() {
        assert_eq!(calculate_crc32(&[]), 0x00000000);
    }

    #[test]
    fn test_crc32_hello() {
        let data = b"Hello, World!";
        let crc = calculate_crc32(data);
        assert_eq!(crc, 0xEC4AC3D0);
    }

    #[test]
    fn test_crc32_streaming() {
        let data = b"Hello, World!";
        let mut hasher = Crc32Hasher::new();
        hasher.update(&data[..5]);
        hasher.update(&data[5..]);
        assert_eq!(hasher.finalize(), calculate_crc32(data));
    }
}
