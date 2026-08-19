# PonsWarp Architecture

> 스켈레톤 — `DIAGNOSIS-REPORT.md` QA-06 후속

## 개요

- 제품: 브라우저 P2P 대용량 파일 전송 (WebRTC DataChannel 스트리밍 + R2 Cloud Drop 폴백)
- 모노레포: `PonsWarp` (Vite/React) + `pons-core-wasm` (Rust/WASM) + `ponswarp-signaling-rs` (Axum 시그널링/R2/빌링/Mesh)

## 모듈 경계

| 모듈 | 책임 | 진입점 |
|---|---|---|
| PonsWarp/src | UI/전송 오케스트레이션 | `App.tsx`, `services/swarmManager.ts`, `services/webRTCService.ts`, `services/directFileWriter.ts` |
| pons-core-wasm | 청크/패킷/암호/ZIP64/WASM | `src/lib.rs`, `crypto/aes_gcm.rs`, `zero_copy_pool.rs`, `reordering_buffer.rs` |
| ponswarp-signaling-rs | 시그널링/R2/빌링/Mesh | `src/main.rs`, `handlers/*`, `protocol/messages.rs` |
| deploy | 배포/Nginx/coturn | `deploy/deploy-production.sh`, `deploy/nginx/*` |

## 배포 토폴로지

- 로컬: `compose.yaml` (signaling 5502 ↔ frontend 3500)
- 운영: Nginx 80→443, `/ws`→Axum WS, `/api/*`→Axum, `dist/` 정적 서빙, coturn 별도 호스트 서비스

## 확장 포인트

- WASM: `aes-gcm`/`hkdf` 크레이트 교체 (M5)
- Frontend: `swarmManager` 모듈 분해 (`swarm/signaling|striping|flowControl`)
- Infra: CI `.github/workflows/ci.yml`, `healthcheck`/`limit_req` 하드닝

---
*상세 다이어그램은 `README.md` Mermaid 참조*
