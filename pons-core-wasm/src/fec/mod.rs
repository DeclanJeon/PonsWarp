//! Forward Error Correction (FEC) 모듈
//!
//! Reed-Solomon 기반 FEC를 제공하여 패킷 손실 시 재전송 없이 복구합니다.
//! - 고지연 환경 (해외 전송, RTT > 100ms)
//! - 모바일 네트워크 (패킷 손실률 > 1%)
//! - 대용량 파일 전송 (100GB+)

mod reed_solomon;

pub use reed_solomon::*;
