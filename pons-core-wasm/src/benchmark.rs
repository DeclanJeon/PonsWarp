//! 성능 벤치마크 유틸리티
//!
//! Zero-Copy 패킷 풀과 레거시 방식의 성능 비교를 위한 도구

use crate::{PacketEncoder, ZeroCopyPacketPool};
use wasm_bindgen::prelude::*;

/// 벤치마크 결과
#[wasm_bindgen(getter_with_clone)]
pub struct BenchmarkResult {
    pub iterations: u32,
    pub total_bytes: u64,
    pub duration_ms: f64,
    pub throughput_mbps: f64,
    pub packets_per_sec: f64,
}

/// 레거시 PacketEncoder 벤치마크
#[wasm_bindgen]
pub fn benchmark_legacy_encoder(chunk_size: usize, iterations: u32) -> BenchmarkResult {
    let mut encoder = PacketEncoder::new();
    let data = vec![0xABu8; chunk_size];

    let start = js_sys::Date::now();

    for _ in 0..iterations {
        let _ = encoder.encode(&data);
    }

    let end = js_sys::Date::now();
    let duration_ms = end - start;
    let total_bytes = (chunk_size as u64) * (iterations as u64);
    let throughput_mbps = if duration_ms > 0.0 {
        (total_bytes as f64 * 8.0) / (duration_ms * 1000.0)
    } else {
        0.0
    };
    let packets_per_sec = if duration_ms > 0.0 {
        (iterations as f64 * 1000.0) / duration_ms
    } else {
        0.0
    };

    BenchmarkResult {
        iterations,
        total_bytes,
        duration_ms,
        throughput_mbps,
        packets_per_sec,
    }
}

/// Zero-Copy 패킷 풀 벤치마크
#[wasm_bindgen]
pub fn benchmark_zero_copy_pool(chunk_size: usize, iterations: u32) -> BenchmarkResult {
    let mut pool = ZeroCopyPacketPool::new();
    let data = vec![0xABu8; chunk_size];

    let start = js_sys::Date::now();

    for _ in 0..iterations {
        let slot_info = pool.acquire_slot();
        let slot_id = slot_info[0] as usize;

        // 실제 사용에서는 WASM 메모리에 직접 쓰지만,
        // 벤치마크에서는 commit만 측정
        let _ = pool.commit_slot(slot_id, chunk_size.min(data.len()));
        pool.release_slot(slot_id);
    }

    let end = js_sys::Date::now();
    let duration_ms = end - start;
    let total_bytes = (chunk_size as u64) * (iterations as u64);
    let throughput_mbps = if duration_ms > 0.0 {
        (total_bytes as f64 * 8.0) / (duration_ms * 1000.0)
    } else {
        0.0
    };
    let packets_per_sec = if duration_ms > 0.0 {
        (iterations as f64 * 1000.0) / duration_ms
    } else {
        0.0
    };

    BenchmarkResult {
        iterations,
        total_bytes,
        duration_ms,
        throughput_mbps,
        packets_per_sec,
    }
}

/// CRC32 벤치마크
#[wasm_bindgen]
pub fn benchmark_crc32(data_size: usize, iterations: u32) -> BenchmarkResult {
    let data = vec![0xABu8; data_size];

    let start = js_sys::Date::now();

    for _ in 0..iterations {
        let _ = crate::calculate_crc32(&data);
    }

    let end = js_sys::Date::now();
    let duration_ms = end - start;
    let total_bytes = (data_size as u64) * (iterations as u64);
    let throughput_mbps = if duration_ms > 0.0 {
        (total_bytes as f64 * 8.0) / (duration_ms * 1000.0)
    } else {
        0.0
    };
    let packets_per_sec = if duration_ms > 0.0 {
        (iterations as f64 * 1000.0) / duration_ms
    } else {
        0.0
    };

    BenchmarkResult {
        iterations,
        total_bytes,
        duration_ms,
        throughput_mbps,
        packets_per_sec,
    }
}
