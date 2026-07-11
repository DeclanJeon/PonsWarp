use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
const MAX_UPDATE_SIZE: usize = 1024 * 1024;

/// Incremental SHA-256 with a bounded update size for browser callers.
#[wasm_bindgen]
pub struct Sha256Stream {
    hasher: Option<Sha256>,
}

impl Sha256Stream {
    fn update_inner(&mut self, data: &[u8]) -> Result<(), &'static str> {
        if data.len() > MAX_UPDATE_SIZE {
            return Err("SHA-256 update exceeds 1 MiB");
        }
        match self.hasher.as_mut() {
            Some(hasher) => {
                hasher.update(data);
                Ok(())
            }
            None => Err("SHA-256 stream is finalized or freed"),
        }
    }

    fn finalize_inner(&mut self) -> Result<Vec<u8>, &'static str> {
        self.hasher
            .take()
            .map(|hasher| hasher.finalize().to_vec())
            .ok_or("SHA-256 stream is finalized or freed")
    }

    fn reset_inner(&mut self) {
        self.hasher = Some(Sha256::new());
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl Sha256Stream {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Sha256Stream {
        Sha256Stream {
            hasher: Some(Sha256::new()),
        }
    }

    pub fn update(&mut self, data: &[u8]) -> Result<(), JsValue> {
        self.update_inner(data).map_err(JsValue::from_str)
    }

    pub fn finalize(&mut self) -> Result<Vec<u8>, JsValue> {
        self.finalize_inner().map_err(JsValue::from_str)
    }

    pub fn reset(&mut self) {
        self.reset_inner();
    }

    pub fn free(&mut self) {
        let _ = self.hasher.take();
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, PartialEq, Eq)]
pub struct Sha256StreamError(&'static str);

#[cfg(not(target_arch = "wasm32"))]
impl std::fmt::Display for Sha256StreamError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl std::error::Error for Sha256StreamError {}

#[cfg(not(target_arch = "wasm32"))]
impl Sha256Stream {
    pub fn new() -> Sha256Stream {
        Sha256Stream {
            hasher: Some(Sha256::new()),
        }
    }

    pub fn update(&mut self, data: &[u8]) -> Result<(), Sha256StreamError> {
        self.update_inner(data).map_err(Sha256StreamError)
    }

    pub fn finalize(&mut self) -> Result<Vec<u8>, Sha256StreamError> {
        self.finalize_inner().map_err(Sha256StreamError)
    }

    pub fn reset(&mut self) {
        self.reset_inner();
    }
    pub fn free(&mut self) {
        let _ = self.hasher.take();
    }
}

impl Default for Sha256Stream {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Sha256Stream {
    fn drop(&mut self) {
        // Take the hasher first (contains digest state), then reset to
        // a fresh instance so any accidental reuse after drop fails closed.
        let _ = self.hasher.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vector_empty() {
        let mut stream = Sha256Stream::new();
        assert_eq!(
            hex(&stream.finalize().unwrap()),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn known_vector_incremental_and_reset() {
        let mut stream = Sha256Stream::new();
        stream.update(b"a").unwrap();
        stream.update(b"bc").unwrap();
        assert_eq!(
            hex(&stream.finalize().unwrap()),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        stream.reset();
        stream.update(b"abc").unwrap();
        assert_eq!(stream.finalize().unwrap().len(), 32);
    }

    #[test]
    fn rejects_oversize_and_second_finalize() {
        let mut stream = Sha256Stream::new();
        assert!(stream.update(&vec![0; MAX_UPDATE_SIZE + 1]).is_err());
        stream.update(b"ok").unwrap();
        stream.finalize().unwrap();
        assert!(stream.finalize().is_err());
        assert!(stream.update(b"no").is_err());
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}
