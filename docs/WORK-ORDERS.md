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

---

## UI/UX QA 보완 작업지시서 — 2026-10-08

**목표:** 클라이언트 UI/UX QA의 18개 항목을 P1 → P2 → P3 순서로 보완한다.
**실행:** 현재 작업 디렉터리에서 순차 실행한다. 기존 사용자 변경은 유지하며, 별도 배포나 자동 커밋은 하지 않는다.
**구조:** React/Vite + Zustand + Tailwind의 기존 컴포넌트와 API 서비스를 수정한다. Cloud Drop은 원본 파일 업로드이므로 종단간 암호화를 새로 구현하지 않고 보안 안내를 실제 동작에 맞춘다.
**명세:** 이 세션의 전체 UI/UX QA 표 QA-01~QA-18. 아래 표가 구현 범위와 수락 기준이다.

### 공통 제약

- 전송 프로토콜·파일 바이트·시그널링 서버·WASM 코어를 변경하지 않는다.
- 잘못된 입력을 임의 코드로 잘라서 받거나 API 오류를 문구로 판별하지 않는다.
- 실패 파일을 숨긴 부분 ZIP을 전체 다운로드 완료로 취급하지 않는다.
- 재시도는 사용자의 명시적 액션으로 실행하며 불필요한 자동 polling은 추가하지 않는다.
- 신규 라이브러리 없이 기존 패턴을 사용한다. 유효한 회귀 테스트는 유지하고 구현 문자열만 고정한 테스트는 제거한다.
- 각 단계는 순차 구현·관찰한다. 전체 type-check/test/build는 통합 완료 시 실행한다.

### 순차 작업 및 수락 기준

| 순서 | 우선순위 | 작업 / 대상 | 수락 기준 | 구현 및 관찰 결과 |
|---|---|---|---|---|
| QA-01 | P1 | ReceiverView ROOM_FULL | 점유 이유, 재시도, 코드 수정이 보이며 빈 화면이 없다. | 완료. 점유 상태 화면과 복구 버튼, 코드 수정 화면 전환 확인. |
| QA-02 | P1 | cloudShareService / cloudShareErrors / CloudDownloadView | HTTP 401/403과 password-required/invalid-password 오류를 구조화한다. 보호된 링크는 비밀번호 폼, 틀린 비밀번호는 폼 내 오류로 표시한다. | 완료. 실제 HTTP status를 보존하는 오류 타입 적용. 403 보호 링크·틀린 비밀번호·정상 해제 브라우저 검증. |
| QA-03 | P1 | App / CloudDownloadView 레이아웃 | 320×568, 390×844, 844×390, 768×1024, 1366×768에서 파일 목록·버튼에 스크롤로 접근할 수 있고 가로 넘침이 없다. | 완료. 다섯 viewport 모두 가로 넘침 없음. 마지막 파일의 44×44 다운로드 버튼까지 스크롤 및 클릭 가능 영역 확인. |
| QA-04 | P1 | CloudDownloadView ZIP 실패 처리 | 일부 파일 실패 시 불완전 ZIP을 저장하지 않고 실패 파일 안내·재시도 제공. 전체 성공 시에만 ZIP 다운로드. | 완료. 2개 중 1개 실패 시 ZIP 저장 0회와 실패 이름·재시도 확인. 전체 성공 시 ZIP 저장 1회, a.txt/b.txt 아카이브 멤버 확인. |
| QA-05 | P1 | App 보안 배지 | P2P에만 E2EE 표시. Cloud는 HTTPS 보장으로 표시하며 같은 안내를 작은 화면에서도 제공한다. | 완료. 모드별 보안 안내 분리. Cloud가 종단간 암호화가 아님을 명시. |
| QA-06 | P1 | ReceiverView 새 세션 | 완료 후 다음 수신·코드 수정·새 참여 시 진행률/속도/용량/대기 플래그 초기화. | 완료. 완료 후 다음 수신의 진행률·속도·용량 0, 빈 입력과 유효성 상태 초기화 확인. |
| QA-07 | P1 | ReceiverView 응답 지연 | soft timeout을 수신 화면에서 표시. 늦은 데이터는 계속 받되 명확한 세션 재연결과 코드 수정 제공. | 완료. 지연 안내 중 RECEIVING과 복구 버튼 유지. 늦은 remote-started 이벤트로 안내가 해제됨을 확인. |
| QA-08 | P2 | ReceiverView 입력 폼 | 연결된 label, 설명, Enter 제출, 오류와 aria-invalid 연결 제공. | 완료. 잘못된 링크의 Enter 제출 시 입력 초점·aria-invalid 유지, 경로 이동 없음. |
| QA-09 | P2 | roomCode / cloudShareCode | Room Code는 정확한 6자리만 허용하며 긴 입력을 잘라 받지 않는다. Drop ID는 기존 8~80자리와 지원하는 표시 형식을 유지한다. 지원하는 URL만 허용하며 임의 문자열·잘못된 경로를 거부한다. 모든 호출부와 계약 테스트 갱신. | 완료. 잘못된 프로토콜·경로·임의 문자열·긴 Room Code 거부와 Drop 표시 코드 roundtrip 회귀 검사. |
| QA-10 | P2 | SenderView 공유 / 공유 복사 UI | 링크와 코드를 별도 버튼으로 복사, Tab/Enter 접근, 성공 안내, 권한 실패 시 수동 선택 지원. CloudSender와 같은 동작 사용. | 완료. 공통 ShareLinkPanel 적용. 브라우저 clipboard의 링크·룸코드 값과 권한 거부 시 전체 링크 선택·안내 확인. |
| QA-11 | P2 | ReceiverView / CloudDownloadView 오류 복구 | 일시 오류에 재조회, 미완료 공유에 상태 새로고침, 방 오류에 코드 수정 제공. optional storage 실패는 공개 다운로드를 차단하지 않는다. | 완료. 503 재조회 성공, 410 새 링크 요청 안내, 잘못된 JSON 응답의 재조회 성공 확인. 저장소 거부 시 메모리 토큰으로 보호 링크 해제·상태 갱신 가능. |
| QA-12 | P2 | CloudDownloadView 미완료 파일 링크 | 미완료 파일은 실행 가능한 href와 Tab 진입이 없고 disabled 상태가 전달된다. | 완료. 미완료 파일은 disabled 버튼이며 다운로드 링크 없음. 명시적 새로고침 후 완료 링크 활성화 확인. |
| QA-13 | P2 | ToastContainer / toastStore | 안정적 live region, 닫기 label, 오류의 수동 닫기, hover/focus 중 자동 제거 정지. | 완료. live log·닫기 label 확인. hover/focus 동안 유지, 해제 후 만료, 오류의 지속 표시 확인. |
| QA-14 | P2 | 진행률 / 단계 안내 | progressbar 이름·수치·최댓값, 단계별 live 안내, 완료/오류/점유 화면 초점 처리. 차단 CONNECTING overlay 대신 비차단 상태 안내. | 완료. 유한한 0~100 진행률과 단계 안내 적용. 보호 링크 해제 후 heading 초점, 상태 화면 및 비차단 연결 안내 확인. |
| QA-15 | P2 | App / SpaceField / CSS | reduced-motion 설정에서 장식 animation·canvas 루프 중단, 설정 변경에도 적용. | 완료. 동일 페이지에서 설정 변경 시 canvas가 즉시 정지하고 해제 시 다시 움직임을 픽셀 비교로 확인. 새로고침 불필요. |
| QA-16 | P2 | usePreventNavigation | 활성 세션당 guard entry 하나. 보호 상태 전환 시 history 증가 없음. Back은 확인 후 승인된 이탈, 거부 시 원래 URL 복원. 완료 후 guard 제거. | 완료. 보호 단계 전환 중 history 길이 일정. Back 거부/승인과 guard 정리 확인. 딥링크 이탈 시 원래 수신 화면이 다시 열리던 popstate 순서 오류 수정·회귀 검증. |
| QA-17 | P3 | 사용자 액션 문구 | Start transfer / Receive files / Receive another / Cancel transfer / Back to options 등 행동 중심으로 통일. | 완료. 실제 액션을 Start sharing, Receive files, Receive more files, Cancel transfer/upload, Back to options로 정리. |
| QA-18 | P3 | 보조 정보 타이포그래피 | 의미 있는 보조 정보는 최소 12px, 본문/입력 14~16px, 어두운 패널에서 읽을 수 있는 대비. 긴 이름은 전체 확인 방법 제공. | 완료. 시스템 본문 폰트·읽기 쉬운 보조 색상·긴 이름 줄바꿈/title 적용. 다섯 viewport의 의미 있는 최소 글자 크기 12px 확인. |

### 검증 초점

1. 보호 링크·잘못된 비밀번호: 서비스 오류 코드 회귀 검사 및 실제 브라우저 API fixture.
2. ZIP 두 파일 중 하나 실패: ZIP이 내려오지 않고 실패 이름과 재시도가 표시됨.
3. ROOM_FULL·완료 후 다음 세션·45초 지연: 상태 전환과 복구 액션 관찰.
4. invalid URL/긴 코드·복사 권한 거부·저장소 접근 거부: 예외가 전체 UI를 종료하지 않음.
5. 가로 폰·큰 폰트·키보드·reduced-motion·Back 거부/승인: 화면 접근성과 세션 보존 확인.

### 실행 상태

- [x] QA-01~QA-07 P1 구현 및 브라우저 관찰
- [x] QA-08~QA-16 P2 구현 및 브라우저 관찰
- [x] QA-17~QA-18 P3 구현 및 브라우저 관찰
- [x] `pnpm --dir PonsWarp type-check`
- [x] `pnpm --dir PonsWarp test`
- [x] `pnpm --dir PonsWarp build`
- [x] 최종 실제 브라우저 smoke 및 환경 제한 기록


### 최종 검증 결과

| 검사 | 관찰 결과 |
|---|---|
| TypeScript | `type-check` 통과 |
| Vitest | 32개 파일, 183개 테스트 통과 |
| Production build | 성공. 기존 WASM의 static/dynamic import 혼용에 따른 chunk 분리 경고는 남아 있음 |
| Playwright | desktop/mobile Chrome 프로젝트에서 8개 시나리오, 총 16개 통과 |
| 키보드 복사 추가 확인 | 링크 입력 → Tab → Copy link → Enter → Tab → Copy room code → Enter로 실제 clipboard 값 확인. 수정된 두 프로젝트 시나리오 재실행 모두 통과 |
| 반응형 실제 화면 | 명세의 다섯 viewport에서 가로 넘침 없음, 마지막 다운로드 버튼까지 스크롤·hit-test 확인. 폰 세로/가로 및 데스크톱 screenshot 시각 확인 |
| 큰 글자 | 320×568, 844×390, 1366×768에서 루트 글꼴 200%(32px) 적용. 가로 넘침 없음, 마지막 다운로드 버튼 88×88 및 클릭 가능 영역 확인 |
| 오류·상태 smoke | ROOM_FULL, 다음 수신 초기화, 지연 안내와 늦은 응답, 503/410/잘못된 JSON 복구, 저장소 거부, 부분 ZIP 차단 및 정상 ZIP 멤버 확인 |
| 모션·history·toast | 같은 페이지의 모션 감소 켜기/끄기 픽셀 비교, 세션 단계별 history 길이 유지와 이탈 확인, toast hover/focus 정지·오류 지속 표시 확인 |

### 검증 범위와 제한

- 실제 클라이언트를 로컬 개발 서버 및 빌드 preview에서 실행했다. API 응답·시그널링은 fixture/mock으로 제어한 시나리오이며 실제 운영 서버의 가용성이나 TLS를 검증한 결과는 아니다.
- 수신 지연의 45초 soft timeout은 브라우저 smoke에서 500ms로 가속하고 수신 서비스/이벤트를 제어했다. 실제 네트워크에서 45초 지연이나 다중 디바이스 전송을 수행한 것은 아니다.
- 모바일 검증은 Chromium viewport 에뮬레이션이다. 물리적 iOS/Android 브라우저의 주소 표시줄·키보드·OS 파일 저장과 스크린리더 실제 낭독은 검증하지 않았다.
- 시그널링 서버와 WASM 코어 소스·전송 프로토콜 변경 없음. 신규 라이브러리 추가, 자동 커밋, 배포 없음.
- 변경 기록은 루트 `CHANGELOG.md`의 Unreleased에 반영했다. 클라이언트 하위 `CHANGELOG.md`의 기존 릴리스 이력은 변경하지 않았다.

