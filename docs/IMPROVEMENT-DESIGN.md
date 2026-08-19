# PonsWarp 개선 설계서

> 기반: `DIAGNOSIS-REPORT.md` · 일자: 2026-08-18 · 작성: 개선 설계 v1

---

## 1. 목표와 비목표

**목표**
- P0 게이트 복구(lint/audit/build)로 main을 항상 배포 가능하게 만든다.
- P1 보안·안정성 치명 결함을 제거한다(TURN 위조, Mesh 우회, 입력 폭증, nonce 재사용, panic).
- 타입·테스트·인프라 부채를 상환해 재발을 구조적으로 막는다.

**비목표**
- 제품 기능 추가(신규 UI/결제 플랜)는 본 설계 범위 밖.
- hand-rolled AES의 완전한 WebCrypto 대체는 별도 마일스톤으로 분리(본 설계는 최소 안전 패치).

---

## 2. 설계 원칙

1. **Fail-closed**: 인증/검증은 기본 거부, 예외는 명시적 허용.
2. **작게 쪼개고 검증 가능하게**: 각 Task는 독립 검증(단위 테스트/린트/빌드) 가능.
3. **점진적 강화**: `strict`·`unwrap`·커버리지는 플래그 → 점진 적용, 한 번에 전역 전환 금지.
4. **재현성**: WASM 빌드·벤치마크는 결정적(deterministic) 파이프라인 유지.

---

## 3. 전체 아키텍처 영향

```
[Browser] --WebSocket /ws--> [Axum signaling] --S3--> [R2]
   |  WebRTC DataChannel (P2P)                ^-- presigned PUT/GET
   +-- pons-core-wasm (chunk/crypto/zip64) ---+
   +-- directFileWriter (FS Access/StreamSaver)

변경 없음: 라우팅 토폴로지/프로토콜 유지. 변경은 각 계층의 "검증·타입·빌드" 경계에만 국한.
```

---

## 4. 도메인별 상세 설계

### 4.1 프론트엔드 타입·상태·품질

**문제**: `strict:false`, 이중 상태, god file, console 우회.

**설계**
- `tsconfig strict` 점진 활성화: `strict:true` + 파일별 `// @ts-expect-error` 허용 후 lint로 수렴. 신규 파일은 strict 필수.
- `App.tsx` 수동 라우팅은 유지하되 `transferStore`를 단일 진실원천으로: `App.cloudShareId` 제거, `transferStore` selector로 동기화. URL 파싱은 `utils/route.ts`로 추출.
- `swarmManager.ts` 분해 로드맵(본 마일스톤은 분해 착수/인터페이스 정의까지, 전체 분해는 후속): `swarm/signaling.ts`, `swarm/striping.ts`, `swarm/flowControl.ts` 로 모듈 경계 문서화.
- 로깅: `logger.ts` 경유 강제, `no-console`을 `warn→error`로 격상. `esbuild.drop`에 `console` 추가는 보류(운영 로그 필요 시 선별).
- `vite-env.d.ts`에 `VITE_*` 타입 보강, `tailwind.config.js` globs를 Tailwind 4 자동탐지 기준으로 정리 또는 제거.

**검증**
- `pnpm --dir PonsWarp type-check` 무오류, `pnpm lint` 0 errors/0 warns(단 `no-explicit-any`는 warn 유지).

### 4.2 WASM 코어 (pons-core-wasm)

**문제**: 수제 AES/GHASH/KDF, nonce 재사용, 메모리 과할당.

**설계 (본 마일스톤: 최소 안전 패치)**
- `aes_gcm.rs`: `nonce_counter`를 `u64`로 확장 + `generate_nonce`가 `nonce_counter` 전체 8B + `random_prefix` 4B 조합으로 12B 구성, 래핑 시 panic 대신 `Result` 반환. `gf_mult`는 유지하되 주석으로 위험 고지, 후속 마일스톤에서 `aes-gcm` 크레이트 교체 로드맵 명시.
- `crypto/kdf.rs`: salt 절단 제거, 32B 초과 시 `sha256(salt)`로 해시 후 사용(RFC 5869 3.3 준수).
- `crypto/parallel.rs`: 문서-구현 불일치 수정 — rayon 미사용이면 문서 정정, `master_key` nonce 누출 제거(`master_key[..4]` 복사 금지).
- `reordering_buffer.rs`: 128 MiB 사전할당 제거, `Arena`를 lazy 할당(필요 시 `Vec::with_capacity` + `try_reserve` 실패 시 `Result`).
- `compression/lz4.rs`: `original_size` 상한(예: 256 MiB) 초과 시 오류, 무조건 `with_capacity(original_size)` 금지.
- `build.sh`/`Cargo.toml`: `wasm-opt` 일관화(`true`로 통일 또는 `build.sh`에서만 수행함을 명시), `wasm-bindgen` 핀(`=0.2.x`), `verify-package.mjs` 버전 체크 유지.

**검증**
- `cargo test -p pons-core-wasm`, `pnpm run wasm:build && node scripts/verify-wasm-provenance.mjs` 통과.

### 4.3 시그널링 서버 (ponswarp-signaling-rs)

**문제**: TURN 위조, Mesh 우회, 입력 무제한, panic, PayPal 토큰 남발.

**설계**
- `handlers/turn.rs:validate_credentials(username, secret)`: `username`을 `base:expiry`로 파싱, `HMAC-SHA1(secret, username)==credential` 검증 추가. `generate_hmac_hash`는 `validate`에서도 재사용, `constant_time_eq` 사용.
- `mesh.rs:authorize_*`: `storage != Postgres` 우회는 `PONSWARP_MESH_ALLOW_INSECURE_MEMORY` 명시 환경변수 없으면 거부(또는 `debug_assertions` 한정). prod에서 memory 단독 배포 시 403.
- `handlers/signaling.rs` + `protocol/messages.rs`: `MAX_SDP_BYTES=256 KiB`, `MAX_CANDIDATE_BYTES=4 KiB`, `MAX_MANIFEST_BYTES=1 MiB` 상수, `handle_*` 진입 시 길이 검사 후 `ServerMessage::Error` 반환. `serde` 역직렬화 전 `Content-Length` 레벨에서도 제한(WS 메시지 크기).
- `billing.rs:validate_return_url`: `Url::parse`로 origin 비교, `public_app_url`의 origin과 일치해야 통과. prefix 우회 차단.
- `billing.rs:access_token`: `tokio::sync::RwLock<Option<CachedToken{token, exp}>>` + 만료 60초 전 갱신, 실패 시 재시도 백오프.
- `config.rs`: `CanonicalOrigin::parse` 실패 시 `panic!` 대신 `Result`로 상향, `Config::from_env() -> Result<Self, ConfigError>` 로 변경. 호출부(`main.rs`)에서 오류 로깅 후 종료.
- `handlers/room.rs`: DashMap 가드 해제 후 `.await` (가드 스코프 축소), `AppState::new`에 `reqwest::Client` 타임아웃(10s) + `pool_max_idle_per_host` 설정.

**검증**
- `cargo test --manifest-path ponswarp-signaling-rs/Cargo.toml --locked` 통과, TURN 위조 테스트/HMAC 불일치 테스트 추가.

### 4.4 인프라·배포·벤치마크

**설계**
- CI: `.github/workflows/ci.yml` 신설 — `pnpm type-check` + `vitest --run` + `cargo test --locked` + `verify:wasm-provenance` + `benchmark:verify` (병렬 job).
- `compose.yaml`: 루트 단일화, `PonsWarp/compose.yaml` 제거(또는 심링크). `healthcheck: curl -f http://localhost:5502/health`, `restart: unless-stopped`, 볼륨 `.:/workspace` → `./:/workspace:ro` + 필요한 쓰기 경로만 별도, 선택적 `postgres:16-alpine` profile 추가.
- `Dockerfile.ponswarp-signaling`: `HEALTHCHECK`, `tini` init, `ubuntu:24.04@sha256:` 핀(또는 `distroless` 검토).
- `nginx`: `limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s` + `limit_req zone=api burst=40 nodelay` for `/api/billing`+`/ws`.
- `benchmarks`: baseline 갱신 SOP 문서화, `PONSWARP_BENCHMARK_IMAGE_DIGEST` 핀.

### 4.5 품질 게이트

**설계**
- `pnpm audit` 0 vulnerabilities: `postcss@>=8.5.23`, `nanoid@>=3.3.18` 로 강제, `pnpm audit --prod`를 CI에 포함.
- `eslint` 0 errors: 미사용 변수 제거/ `_` prefix, `no-constant-condition` 수정, `Function` 타입 제거.
- ` vitest.config.ts` `coverage.thresholds: { lines: 40, statements: 40, branches: 30 }` 초기치 설정 후 점진 상향.
- Rust: `Cargo.toml [lints.clippy] unwrap_used = "deny"` + `#[allow(clippy::unwrap_used)]`는 `#[cfg(test)]`에만 허용, prod `unwrap`은 `anyhow::Context`/`expect` 메시지로 교체.
- `.gitignore`에 `.commandcode/` 추가, `docs/design/ARCHITECTURE.md` 스켈레톤 작성.

---

## 5. 마이그레이션 계획

| 단계 | 내용 | 선행 조건 |
|---|---|---|
| M1 P0 | audit/lint/DEBUG/strict 최소 수정 | 없음 |
| M2 P1 보안 | TURN HMAC + origin 검증 + 입력 제한 + token 캐시 | M1 |
| M3 P1 안정성 | WASM 메모리/KDF/nonce 패치, config panic 제거, unwrap 정리 | M2 |
| M4 P2 하드닝 | CI/compose/Docker/NGINX/커버리지 게이트 | M1 |
| M5 후속 | hand-rolled AES → `aes-gcm` 교체, swarmManager 분해, strict 전역화 | M3 |

각 단계는 `type-check`/`lint`/`test`/`build`가 green이어야 다음 단계 진입.

---

## 6. 위험과 롤백

- `strict:true` 전역 전환 시 100+ 오류 가능 → 본 설계는 점진 적용으로 위험 회피.
- `validate_credentials` 시그니처 변경은 호출부 0곳(내부만) → 호환성 무해.
- WASM 메모리 lazy화는 기존 128 MiB 가정 테스트에 영향 → `reordering_buffer` 테스트에 `Arena` 크기 어설션 완화.
- 롤백: 각 Task는 단일 커밋, `git revert`로 개별 롤백 가능.

---

## 7. 대안 검토

- **AES 완전 교체 vs 최소 패치**: 완전 교체가 이상적이나 WASM 바인딩 변경 범위가 커 별도 마일스톤으로 분리. 본 설계는 nonce/KDF 즉시 위험만 차단.
- **`strict` 전역 즉시 적용**: 품질 이득 크나 1,000줄 이상 수정 필요 → 점진 적용 선택.
- **`aes-gcm` + `hkdf` 크레이트 도입**: 후속 M5에서 채택, 본 설계는 문서·로드맵만.

---

## 8. 검증 계획

- `pnpm run preflight` (type-check + frontend:test + backend:test)
- `pnpm --dir PonsWarp lint`
- `pnpm audit --prod` 0 vulnerabilities
- `cargo test --locked` (workspace)
- `pnpm run wasm:build && node scripts/verify-wasm-provenance.mjs`
- `docker compose config` 유효성 + `nginx -t` (가능 시)

---

*다음 문서: `WORK-ORDERS.md` (작업지시서)*
