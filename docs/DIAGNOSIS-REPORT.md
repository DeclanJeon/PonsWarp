# PonsWarp 전체 진단 보고서

> 작성일: 2026-08-18 · 기준 커밋: `a3dbc34` (master) · 범위: 루트 모노레포 전체
> 방법: 정적 분석 + 5개 병렬 심층 탐색 (프로젝트 구조 / 프론트엔드 / Rust·WASM / 배포·인프라 / 마커·품질)

---

## 1. 프로젝트 개요

| 항목 | 내용 |
|---|---|
| 제품 | 브라우저 P2P 대용량 파일 전송 (WebRTC DataChannel 스트리밍 + Cloud Drop R2 폴백) |
| 모노레포 | `pnpm-workspace` [PonsWarp, pons-core-wasm] + `Cargo workspace` [ponswarp-signaling-rs, pons-core-wasm] |
| 프론트엔드 | React 19 + Vite 7 + TypeScript 5.9 + Tailwind 4 + Zustand + Three/R3F (SpaceField) |
| 시그널링 | Rust/Tokio/Axum 0.7 + DashMap + sqlx Postgres + S3(R2) + HMAC-SHA1 TURN |
| WASM 코어 | Rust→WASM (wasm-bindgen/miniz_oxide/sha2), `pkg/` 산출물 `workspace:*` 소비 |
| 배포 | `deploy/deploy-production.sh` + Nginx + coturn + `compose.yaml` (local) |
| 버전 | PonsWarp 0.7.3 / pons-core-wasm 0.4.3 / ponswarp-signaling-rs 0.1.0 |

실행 경로: `PonsWarp/src/App.tsx` (수동 라우팅) → `swarmManager/webRTCService/directFileWriter` → `pons-core-wasm` → WebRTC → `directFileWriter` (StreamSaver/FS Access). 시그널링: `ponswarp-signaling-rs/src/main.rs` Axum 라우터 (`/ws`, `/health`, `/ready`, `/api/*`).

---

## 2. 진단 방법

- 5개 병렬 explore 에이전트 (thorough): 개요 / 프론트엔드 / Rust·WASM / 배포·인프라 / TODO·취약점·린트·커버리지
- 교차 검증: `package.json`/`Cargo.toml`/`tsconfig`/`vite.config`/`config.rs`/`main.rs`/`handlers/*` 샘플 정독, `pnpm audit`/`eslint`/`cargo grep`/`vitest coverage` 증거 수집

---

## 3. 종합 판정

**컨벤션 TODO 0건이나 침묵 부채 다수.** 제품·문서·배포 스크립트는 성숙하나 타입/테스트/보안/CI가 구멍.

| 축 | 판정 | 근거 |
|---|---|---|
| 보안 | 🔴 High | TURN HMAC 미검증, Mesh memory 우회, 입력 크기 무제한, Billing prefix 우회, hand-rolled AES |
| 안정성 | 🔴 High | Rust `unwrap` ~40곳 panic, 32-bit nonce 재사용, LZ4 4 GiB 할당, 128 MiB WASM 사전할당 |
| 타입·품질 | 🟡 Medium | `strict:false`, `as any` 9곳, god file 2,800줄, `console.*` 49곳 |
| 테스트 | 🟡 Medium | 34.7% 커버리지, 핵심 경로 1~18%, threshold 없음 |
| 인프라 | 🟡 Medium | CI 없음, compose 중복, Docker/NGINX 하드닝 부재 |

---

## 4. 영역별 상세 진단

### 4.1 프론트엔드 (`PonsWarp/`)

**강점**
- 제품 완성도 높음, 상태스토어(Zustand)·워커 분리·Vite 청크 분할 적절

**문제**

| ID | 심각도 | 내용 | 증거 |
|---|---|---|---|
| FE-01 | High | `tsconfig strict:false` + `no-explicit-any:warn` → null/안전성 구멍 | `PonsWarp/tsconfig.json:23`, `PonsWarp/.eslintrc.json:35` |
| FE-02 | High | `App.tsx` 수동 라우팅 + 이중 상태(`AppMode` 12 vs `TransferStatus` 14 vs `transfer/state` 9) 드리프트 | `PonsWarp/src/App.tsx:62-115`, `store/transferStore.ts:136` |
| FE-03 | High | 상태 중복(store vs 컴포넌트 local `roomId/manifest/progress`) + StrictMode `setTimeout 100ms` 핵 | `store/transferStore.ts:213`, `components/ReceiverView.tsx:506` |
| FE-04 | Medium | God file `swarmManager.ts` ~2,800줄 180+ 메서드 | `PonsWarp/src/services/swarmManager.ts` |
| FE-05 | Medium | `console.*` 49곳이 `logger.ts` 우회, `esbuild.drop`은 `debugger`만 제거 | `vite.config.ts:117`, `services/signaling.ts:102` 외 |
| FE-06 | Medium | DEBUG 스캐폴딩 6파일에 prod 잔존 | `services/swarmManager.ts:1-9`, `components/SenderView:2-6`, `components/ReceiverView:2-6`, `services/signaling-adapter:150`, `index.css:3` |
| FE-07 | Low | `vite-env.d.ts`에 `VITE_HYBRID_HTTP_ASSIST` 등 미선언, `tailwind.config.js` globs stale | `vite-env.d.ts:3-8`, `tailwind.config.js:3-9` |
| FE-08 | Low | `socket.io-client` + `transport-vendor` 청크 사문화(현재 ws://) | `vite.config.ts:47-51`, `package.json:36` |

### 4.2 Rust·WASM 코어 (`pons-core-wasm/`)

| ID | 심각도 | 내용 | 증거 |
|---|---|---|---|
| WC-01 | 🔴 High | 수제 AES-256-GCM: `nonce_counter 32bit` 래핑 시 nonce 재사용 → GCM 붕괴, `gf_mult` O(n·128), S-Box 타이밍 채널 | `pons-core-wasm/src/crypto/aes_gcm.rs:271,393` |
| WC-02 | High | SHA-256 3중복(hand-rolled 2곳 + `sha2` crate) | `merkle_tree.rs:14`, `crypto/kdf.rs:21`, `sha256_stream.rs` |
| WC-03 | High | `ReorderingBuffer::Arena::new()` 128 MiB 무조건 사전할당 (WASM 256 MiB 한계 OOM) | `pons-core-wasm/src/reordering_buffer.rs:22` |
| WC-04 | High | KDF salt를 `min(len,32)`로 절단 → RFC 5869 불일치 | `pons-core-wasm/src/crypto/kdf.rs` |
| WC-05 | Medium | `parallel.rs` rayon 문서와 달리 순차 루프 + `master_key` nonce 누출 + `MAX_PARALLEL_CHUNKS` 미사용 | `pons-core-wasm/src/crypto/parallel.rs` |
| WC-06 | Medium | `ZeroCopyPacketPool` 실패 시 `0` 반환 침묵, `ReorderingBuffer` oversize 침묵 드롭 | `zero_copy_pool.rs:76`, `reordering_buffer.rs:127` |
| WC-07 | Medium | `Lz4Decompress`가 `original_size: u32` 신뢰 → 4 GiB `Vec` 할당 | `compression/lz4.rs` |
| WC-08 | Medium | `build.sh` `wasm-opt -O4` vs `Cargo.toml wasm-opt=false` 불일치, `wasm-bindgen` 미핀 | `pons-core-wasm/build.sh`, `Cargo.toml` |

### 4.3 시그널링 서버 (`ponswarp-signaling-rs/`)

| ID | 심각도 | 내용 | 증거 |
|---|---|---|---|
| BE-01 | 🔴 High | `validate_credentials`가 HMAC 검증 없이 `expiry > now`만 확인 → 자격증명 위조 | `handlers/turn.rs:204-215` |
| BE-02 | 🔴 High | Mesh `storage != Postgres`이면 `authorize_*`가 `Ok(Admin)` 반환 → memory 배포 시 인증 전체 우회 | `mesh.rs:1408-1416` |
| BE-03 | High | `Offer/Answer.sdp`·`candidate`·`manifest` 크기 제한 없음 → 증폭 DoS | `handlers/signaling.rs:8-113`, `main.rs` ClientMessage |
| BE-04 | High | `config.rs` `CanonicalOrigin::parse().unwrap_or_else(|e| panic!())` 등 startup panic | `config.rs:280,320` |
| BE-05 | High | PayPal `access_token` 매 요청 재발급(캐시 없음), `validate_return_url` prefix 체크로 `warp.ponslink.com.evil.com` 우회 | `billing.rs:619,686-694` |
| BE-06 | Medium | `handlers/room.rs` DashMap 가드 유지 중 `.await` → 샤드 stall | `handlers/room.rs:17,144` |
| BE-07 | Medium | Google `tokeninfo` GET에 `id_token` 노출, HMAC-SHA1 세션 해시 | `auth.rs` |
| BE-08 | Medium | `AppState::new` `reqwest::Client::new()` 타임아웃/풀 제한 없음, 무제한 `mpsc::unbounded_channel` | `state.rs` |
| BE-09 | Medium | `validate_return_url` origin 파싱 없이 `starts_with` | `billing.rs:686` |

### 4.4 배포·인프라·벤치마크

| ID | 심각도 | 내용 | 증거 |
|---|---|---|---|
| OP-01 | High | CI 없음: `.github/workflows/` 미존재, nightly 템플릿만 존재 | `deploy/github-workflows/nightly-prod-transfer-qa.yml` |
| OP-02 | Medium | `compose.yaml` 루트/`PonsWarp/compose.yaml` 완전 중복, `postgres`/`coturn`/`healthcheck`/`restart` 없음, `..:/workspace` 광범위 마운트 | `compose.yaml:6,38` |
| OP-03 | Medium | `Dockerfile.ponswarp-signaling` `HEALTHCHECK`/`tini` 없음, `ubuntu:24.04` 미핀 | `deploy/Dockerfile.ponswarp-signaling` |
| OP-04 | Medium | `nginx/warp.ponslink.com.conf` `limit_req`/`proxy_next_upstream` 없음 | `deploy/nginx/warp.ponslink.com.conf` |
| OP-05 | Low | `benchmarks/v1` fingerprint 불일치 시 fail-closed로 baseline 갱신 SOP 부재 | `benchmarks/v1/run.mjs` |

### 4.5 품질 게이트

| ID | 심각도 | 내용 | 증거 |
|---|---|---|---|
| QA-01 | High | `pnpm audit` 5건: `nanoid <3.3.18`, `postcss ≤8.5.22` | `@tailwindcss/postcss@4.3.2` 경유 |
| QA-02 | High | `eslint` 13 errors (미사용 변수 등)로 `lint` 실패 | `directFileWriter:56`, `swarmManager:55`, `stripeSignal:1`, `webRTCService:1303` 등 |
| QA-03 | High | Rust `unwrap/expect` ~78곳, prod panic ~40곳, `cargo clippy unwrap_used` 미설정 | `packet.rs:178`, `reordering_buffer.rs:148` 등 |
| QA-04 | Medium | 커버리지 34.76% (swarmManager 18%, signaling 4%, cloudShare 15%, bulkEncrypt 1%) threshold 없음 | `vitest.config.ts`, `PonsWarp` 32 suites 166 tests |
| QA-05 | Low | 50개 파일 unstaged + `.commandcode/` untracked, `.gitignore` 미등록 | `git status` |
| QA-06 | Low | `docs/design/` 비어있음, `SECURITY.md`/`ARCHITECTURE.md` 없음 | `docs/` |

---

## 5. 메트릭 요약

- TODO/FIXME/HACK: 0 / `ts-ignore`: 0 / `ts-expect-error`: 3 (정당) / `eslint-disable`: 1
- ESLint: 13 errors + 12 warnings (`--fix` 미적용 시 실패)
- Audit: 5 vulnerabilities (high 3, moderate 1)
- Coverage: 34.76% lines, 임계치 없음
- Rust unwrap: ~78 hits (test 제외 ~40 prod)
- Unstaged: 50 files + 1 untracked dir

---

## 6. 우선순위 요약

| 우선순위 | 항목 | 기대 효과 |
|---|---|---|
| P0 | QA-01/02/05, FE-06, WC-08, OP-01 일부 | 빌드 게이트 복구, prod 노이즈 제거 |
| P1 | BE-01/02/03/05/09, WC-01/03/07, FE-01 일부, QA-03 일부 | 보안·안정성 치명 결함 해소 |
| P2 | FE-04/05, WC-02/04/05, BE-04/06/07, OP-02/03/04, QA-04 | 부채 상환·하드닝·커버리지 |

---

## 7. 참고: 강점

- 프로토콜/호환성/패리티 3계층 컨트랙트 동결 및 `deploy-production.sh` (0600 시크릿, blue/green 5502↔5503, ControlMaster, health smoke) 견고
- 문서화(README 384줄, 아키텍처 머메이드)와 `verify:wasm-provenance` 재현성 체크 우수

---

*다음 문서: `IMPROVEMENT-DESIGN.md` (개선 설계), `WORK-ORDERS.md` (작업지시서)*
