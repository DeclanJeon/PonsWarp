mod benchmark;
mod chunk_pool;
pub mod compression;
mod crc32;
pub mod crypto;
pub mod fec;
mod file_signature;
mod merkle_tree;
mod packet;
mod reordering_buffer;
mod sha256_stream;
mod zero_copy_pool;
pub mod zip64;

pub use benchmark::*;
pub use chunk_pool::*;
pub use compression::*;
pub use crc32::*;
pub use crypto::*;
pub use fec::*;
pub use file_signature::*;
pub use merkle_tree::*;
pub use packet::*;
pub use reordering_buffer::*;
pub use sha256_stream::Sha256Stream;
pub use zero_copy_pool::*;
pub use zip64::Zip64Stream;

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    // WASM 모듈 초기화
}
