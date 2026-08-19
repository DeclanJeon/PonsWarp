# PonsWarp 작업지시서

> 기반: `DIAGNOSIS-REPORT.md`, `IMPROVEMENT-DESIGN.md` · 일자: 2026-08-18
> 표기: WO = Work Order, P0/P1/P2 = 우선순위, DoD = Definition of Done

---

## 0. 공통 규칙

- 각 WO는 독립 브랜치/커밋으로 진행, `type-check`/`lint`/`test`/`build` green 후 다음 WO 진입.
- 파일 경로는 repo root 기준.
- 본 지시서 순서대로 구현하되, P0가 P1/P2보다 우선.

---

## WO-01 — 의존성 취약점 패치 (P0)

**배경**: QA-01

| 항목 | 내용 |
|---|---|
| 범위 | `PonsWarp/package.json`, `pnpm-lock.yaml` |
| 작업 | `postcss@>=8.5.23`, `nanoid@>=3.3.18` 로 업그레이드. `pnpm up postcss@8.5.23 nanoid@3.3.18` (또는 `pnpm up -w`). `@tailwindcss/postcss` 경유이므로 dedup 확인. |
| DoD | `pnpm audit --prod` 0 vulnerabilities, `pnpm --dir PonsWarp build` 성공 |
| 검증 | `pnpm audit`, `pnpm --dir PonsWarp type-check` |
| 의존성 | 없음 |

---

## WO-02 — ESLint 13 Errors 수정 (P0)

**배경**: QA-02

| 항목 | 내용 |
|---|---|
| 범위 | `PonsWarp/src/services/directFileWriter.ts:56`, `hybridBulkTransport.ts:18`, `stripeSignal.ts:1,19`, `swarmManager.ts:55`, `swarmStripe.ts:36`, `webRTCService.ts:1303`, `utils/appUpdateService.test.ts:49,64`, `utils/transferFlowControl.test.ts:12`, `workers/file-sender.worker.ts:551,1042`, plus 12 `no-explicit-any` warns 정리(가능 범위) |
| 작업 | 미사용 변수 제거 또는 `_` prefix, `no-constant-condition` 리팩터, `Function` 타입 구체화. `eslint --fix` 후 수동 잔여 정리. |
| DoD | `pnpm --dir PonsWarp lint` 0 errors (warn는 `no-explicit-any`만 허용 시 0 warns 목표) |
| 검증 | `pnpm --dir PonsWarp lint` |
| 의존성 | 없음 |

---

## WO-03 — DEBUG 스캐폴딩 정리 (P0)

**배경**: FE-06

| 항목 | 내용 |
|---|---|
| 범위 | `PonsWarp/src/services/swarmManager.ts:1-9`, `PonsWarp/src/components/SenderView.tsx:2-6`, `PonsWarp/src/components/ReceiverView.tsx:2-6`, `PonsWarp/src/services/signaling-adapter.ts:150,153,156,163,166,169`, `PonsWarp/index.css:3,129` |
| 작업 | prod에 노출되는 `debugLog`/`// 🪲` 배너 제거 또는 `if (import.meta.env.DEV)` 가드. `index.css` 디버그 주석 제거. |
| DoD | `grep -R "🪲\|ARCHITECTURE CONSISTENT\|DEBUG.*진단" PonsWarp/src` 0건, dev/prod 빌드 정상 |
| 검증 | grep, `pnpm --dir PonsWarp build` |
| 의존성 | WO-02 이후 권장 |

---

## WO-04 — .gitignore 및 문서 스켈레톤 (P0/P2)

**배경**: QA-05/06

| 항목 | 내용 |
|---|---|
| 범위 | `.gitignore`, `docs/design/ARCHITECTURE.md` |
| 작업 | `.gitignore`에 `.commandcode/` 추가. `docs/design/ARCHITECTURE.md` 스켈레톤(제품 개요/모듈 경계/배포 토폴로지). |
| DoD | `git status`에 `.commandcode/` 미표시, 문서 파일 존재 |
| 검증 | `git status`, `ls docs/design/` |
| 의존성 | 없음 |

---

## WO-05 — TURN 자격증명 HMAC 검증 (P1 보안)

**배경**: BE-01

| 항목 | 내용 |
|---|---|
| 범위 | `ponswarp-signaling-rs/src/handlers/turn.rs:204-215`, 테스트 추가 |
| 작업 | `validate_credentials(username: &str, secret: &str) -> bool` 로 변경. `username`을 `base:expiry`로 분리, `expiry > now` + `HMAC-SHA1(secret, username)==credential` 검증, `subtle::ConstantTimeEq` 사용. 호출부 없음(내부)이므로 시그니처 변경 무해. |
| DoD | 위조 username(`user:9999999999` without HMAC) 거부 테스트 통과, 기존 TURN 발급 플로우 정상 |
| 검증 | `cargo test --manifest-path ponswarp-signaling-rs/Cargo.toml --locked -p ponswarp-signaling-rs turn` |
| 의존성 | 없음 |

---

## WO-06 — Billing return_url Origin 검증 + PayPal token 캐시 (P1 보안)

**배경**: BE-05/09

| 항목 | 내용 |
|---|---|
| 범위 | `ponswarp-signaling-rs/src/billing.rs:619,686-694` |
| 작업 | `validate_return_url`을 `url::Url::parse` + origin 비교로 교체(`warp.ponslink.com.evil.com` 차단). `access_token`에 `RwLock<Option<CachedToken>>` 캐시(만료 60초 전 갱신). `url` crate 필요 시 `Cargo.toml` 추가. |
| DoD | prefix 우회 실패 테스트, token 캐시 히트 로그/테스트, 기존 checkout/capture 정상 |
| 검증 | `cargo test -p ponswarp-signaling-rs billing` |
| 의존성 | WO-05 이후 권장 |

---

## WO-07 — 시그널링 입력 크기 제한 (P1 보안)

**배경**: BE-03

| 항목 | 내용 |
|---|---|
| 범위 | `ponswarp-signaling-rs/src/handlers/signaling.rs`, `ponswarp-signaling-rs/src/protocol/messages.rs`, `ponswarp-signaling-rs/src/main.rs` |
| 작업 | 상수 `MAX_SDP_BYTES=256*1024`, `MAX_CANDIDATE_BYTES=4096`, `MAX_MANIFEST_BYTES=1024*1024` 정의. `handle_offer/answer/ice_candidate/manifest` 진입 시 길이 검사 후 `ServerMessage::Error` 반환. WS 프레임 크기 제한도 `axum` 레벨에서 검토. |
| DoD | 초과 페이로드 거부 테스트, 정상 페이로드 통과 |
| 검증 | `cargo test -p ponswarp-signaling-rs` |
| 의존성 | 없음 |

---

## WO-08 — Mesh memory 인증 우회 차단 (P1 보안)

**배경**: BE-02

| 항목 | 내용 |
|---|---|
| 범위 | `ponswarp-signaling-rs/src/mesh.rs:1408-1416`, `ponswarp-signaling-rs/src/config.rs` |
| 작업 | `authorize_mesh_action`/`authorize_workspace_or_node_action`의 `storage != Postgres → Ok` 분기를 `PONSWARP_MESH_ALLOW_INSECURE_MEMORY=true` 또는 `cfg(debug_assertions)` 일 때만 허용, 그 외 403. 환경변수 `MeshConfig`에 필드 추가 시 `config.rs`에 반영. |
| DoD | prod(`PONSWARP_ENV=production`, `storage=memory` 기본) 에서 인증 없이 mesh API 호출 시 403, dev에서 허용 |
| 검증 | `cargo test -p ponswarp-signaling-rs mesh` |
| 의존성 | WO-07 이후 권장 |

---

## WO-09 — Rust config panic 제거 (P1 안정성)

**배경**: BE-04

| 항목 | 내용 |
|---|---|
| 범위 | `ponswarp-signaling-rs/src/config.rs:280,320`, `ponswarp-signaling-rs/src/main.rs` |
| 작업 | `Config::from_env() -> Result<Self, ConfigError>` 로 변경, `CanonicalOrigin::parse`/`MeshStorage::from_env_value` 실패 시 `Err` 반환. `main.rs`에서 오류 로깅 후 `std::process::exit(1)`. `unwrap_or(default)` 수치 파싱은 유지하되 오류 로깅 추가(선택). |
| DoD | 잘못된 `LAN_EVIDENCE_WS_ORIGINS`/`PONSWARP_MESH_STORAGE` 로 시작 시 panic 대신 오류 메시지 후 종료, 정상 시작 시 기존 동작 유지 |
| 검증 | `cargo test -p ponswarp-signaling-rs`, 수동 `LAN_EVIDENCE_WS_ORIGINS=bad` 기동 테스트 |
| 의존성 | WO-07 이후 |

---

## WO-10 — WASM 최소 안전 패치 (P1 안정성)

**배경**: WC-01/03/04/05/07

| 항목 | 내용 |
|---|---|
| 범위 | `pons-core-wasm/src/crypto/aes_gcm.rs`, `crypto/kdf.rs`, `crypto/parallel.rs`, `reordering_buffer.rs`, `compression/lz4.rs` |
| 작업 | (a) `nonce_counter u32→u64`, `generate_nonce` 12B 구성 수정 및 래핑 시 `Result` 반환. (b) `kdf.rs` salt 절단 제거, 32B 초과 시 `sha256(salt)`. (c) `parallel.rs` 문서-구현 불일치 해소, `master_key` nonce 누출 제거. (d) `reordering_buffer.rs` 128 MiB 사전할당 제거, lazy 할당. (e) `lz4.rs` `original_size` 상한(256 MiB) 및 `with_capacity` 제한. |
| DoD | `cargo test -p pons-core-wasm`, `pnpm run wasm:build && node scripts/verify-wasm-provenance.mjs` 통과 |
| 검증 | `cargo test -p pons-core-wasm`, `pnpm run wasm:build` |
| 의존성 | WO-02 이후 |

---

## WO-11 — Rust unwrap 정리 (P1 안정성)

**배경**: QA-03

| 항목 | 내용 |
|---|---|
| 범위 | `pons-core-wasm/src/packet.rs:178`, `reordering_buffer.rs:148,172`, `zip64/structures.rs:230`, `ponswarp-signaling-rs/src/main.rs:178,370,382`, `ponswarp-signaling-rs/src/mesh.rs:622,1114` 등 prod `unwrap` |
| 작업 | `Cargo.toml [lints.clippy] unwrap_used = "deny"` 추가, `#[allow(clippy::unwrap_used)]`는 `#[cfg(test)]`에만 허용. prod `unwrap`은 `anyhow::Context`/`ok_or`/`expect("...")`로 교체, 비즈니스 로직은 `Result` 전파. |
| DoD | `cargo clippy -- -D clippy::unwrap_used`에서 prod 코드 0건, `cargo test` 통과 |
| 검증 | `cargo clippy`, `cargo test --locked` |
| 의존성 | WO-09/10 이후 |

---

## WO-12 — TypeScript strict 점진 강화 (P2)

**배경**: FE-01, WC-08 일부

| 항목 | 내용 |
|---|---|
| 범위 | `PonsWarp/tsconfig.json`, `PonsWarp/vite-env.d.ts`, `PonsWarp/src/utils/*`, `PonsWarp/src/services/*` (점진) |
| 작업 | `tsconfig.json strict:true` 활성화 또는 `strictNullChecks`/`noImplicitAny`부터 점진. `vite-env.d.ts`에 `VITE_*` 타입 보강. 신규 파일 strict 필수, 기존 파일은 `@ts-expect-error`로 수렴. |
| DoD | `pnpm --dir PonsWarp type-check` 0 errors, 기존 테스트 통과 |
| 검증 | `pnpm --dir PonsWarp type-check`, `pnpm --dir PonsWarp test` |
| 의존성 | WO-02 이후 |

---

## WO-13 — CI/compose/Docker/Nginx 하드닝 (P2)

**배경**: OP-01/02/03/04, WC-08

| 항목 | 내용 |
|---|---|
| 범위 | `.github/workflows/ci.yml` 신설, `compose.yaml`, `deploy/Dockerfile.ponswarp-signaling`, `deploy/nginx/warp.ponslink.com.conf`, `pons-core-wasm/build.sh`/`Cargo.toml` |
| 작업 | (a) CI: `type-check`, `vitest`, `cargo test --locked`, `verify:wasm-provenance`, `pnpm audit` 병렬 job. (b) compose: 루트 단일화, `healthcheck`, `restart: unless-stopped`, 볼륨 최소화, 선택적 `postgres` profile. (c) Dockerfile: `HEALTHCHECK`+`tini`+베이스 핀. (d) nginx: `limit_req` for `/api/billing`+`/ws`. (e) WASM: `wasm-opt` 일관화, `wasm-bindgen` 핀. |
| DoD | `gh workflow` 또는 로컬 `act`에서 CI green, `docker compose config` 유효, `nginx -t` 통과(가능 시) |
| 검증 | CI 실행, `docker compose config`, `cargo test` |
| 의존성 | WO-01/02 이후 |

---

## WO-14 — 커버리지 게이트 및 문서화 (P2)

**배경**: QA-04/06, FE-05 일부

| 항목 | 내용 |
|---|---|
| 범위 | `PonsWarp/vitest.config.ts`, `PonsWarp/src/services/*`, `docs/design/ARCHITECTURE.md` |
| 작업 | `vitest.config.ts coverage.thresholds` 초기치 설정(lines 40 등). 핵심 경로(`swarmManager`, `directFileWriter`) 커버리지 보강 테스트 최소 1건씩. `no-console` 룰 격상 검토. |
| DoD | `pnpm --dir PonsWarp test -- --coverage` threshold 미달 시 실패, 문서 존재 |
| 검증 | `pnpm --dir PonsWarp test -- --coverage` |
| 의존성 | WO-02/12 이후 |

---

## 작업 순서 (권장)

```
WO-01 → WO-02 → WO-03 → WO-04 → WO-05 → WO-06 → WO-07 → WO-08 → WO-09 → WO-10 → WO-11 → WO-12 → WO-13 → WO-14
       └──────── P0 ────────┘   └────────────── P1 보안·안정성 ──────────────┘   └──── P2 하드닝 ────┘
```

- 병렬 가능: WO-01/WO-02, WO-05/WO-07, WO-10/WO-09
- 각 WO 완료 시 `preflight`(type-check + frontend:test + backend:test) green 필수

---

## 검증 체크리스트 (전체)

- [ ] `pnpm audit --prod` 0 vulnerabilities
- [ ] `pnpm --dir PonsWarp lint` 0 errors
- [ ] `pnpm --dir PonsWarp type-check` 0 errors
- [ ] `pnpm --dir PonsWarp test` 166+/166 pass (또는 threshold green)
- [ ] `cargo test --locked` (workspace) pass
- [ ] `cargo clippy -- -D clippy::unwrap_used` prod 0건
- [ ] `pnpm run wasm:build && node scripts/verify-wasm-provenance.mjs` pass
- [ ] `docker compose config` 유효
- [ ] 보안 회귀 테스트: TURN 위조 거부, return_url prefix 우회 차단, SDP 초과 거부, mesh memory 403

---

*구현은 본 지시서 순서대로 진행하며, 각 WO는 독립 커밋으로 기록한다.*
