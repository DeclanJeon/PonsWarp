# PonsWarp Signaling Server (Rust)

고성능 WebRTC 시그널링 서버 - Rust + Tokio + Axum 기반

## 특징

- **고성능**: Rust의 제로 코스트 추상화와 Tokio 비동기 런타임
- **Thread-safe**: DashMap을 활용한 동시성 안전 상태 관리
- **WebSocket**: axum-ws 기반 실시간 통신
- **TURN 지원**: RFC 5766 HMAC-SHA1 자격증명 생성

## 빌드 및 실행

```bash
# 개발 모드
cargo run

# 릴리즈 빌드
cargo build --release
./target/release/ponswarp-signaling-rs
```

## 환경 변수

환경별 템플릿을 복사해서 사용합니다. 실제 키와 secret은 Git에 커밋하지 마세요.

```bash
# 로컬 개발
cp .env.local.example .env.local
cargo run

# 운영 설정 파일로 실행
cp .env.production.example .env.production
PONSWARP_ENV=production cargo run --release

# 또는 명시 파일 지정
PONSWARP_ENV_FILE=/secure/path/ponswarp-signaling.env ./target/release/ponswarp-signaling-rs
```

서버는 먼저 `.env`를 읽고, `PONSWARP_ENV`에 따라 `.env.local`, `.env.production`, `.env.<env>.local`을 추가로 읽습니다. `PONSWARP_ENV_FILE`이 있으면 `.env` 이후 해당 파일을 가장 마지막에 읽어 값을 덮어씁니다.

운영 배포는 저장소 루트의 `deploy/deploy-production.sh`를 사용합니다. 이 스크립트는 백엔드 env-file을 항상 `signaling-rs/.env.production`에서 업로드하고 Docker 실행 시 `PONSWARP_ENV=production`을 명시합니다. 운영 배포용 값은 `.env`나 `.env.local`이 아니라 `.env.production`에 넣어야 합니다.

## API

- `GET /` - 서버 정보
- `GET /health` - 헬스 체크
- `GET /ready` - 운영 readiness 체크
- `GET /ws` - WebSocket 엔드포인트
- `GET /api/auth/me` - 현재 로그인 세션 조회
- `GET /api/auth/google/start` - Google OAuth 로그인 시작
- `GET /auth/google/callback` - Google OAuth 콜백
- `GET /api/auth/google/callback` - Google OAuth 콜백 호환 경로
- `POST /api/auth/logout` - 현재 세션 로그아웃
- `GET /api/cloud-plans` - Cloud Drop 무료/유료 플랜 제한 조회
- `POST /api/cloud-share` - Cloudflare R2 Cloud Drop 공유 생성 및 업로드 URL 발급
- `POST /api/cloud-share/:share_id/complete` - 공유 업로드 완료 처리
- `GET /api/cloud-share/:share_id` - 공개 다운로드 매니페스트 조회
- `POST /api/cloud-share/:share_id` - 비밀번호/다운로드 세션 기반 공개 매니페스트 접근
- `GET /api/cloud-share/:share_id/files/:file_id/download` - 파일 다운로드 URL 리다이렉트

### Cloudflare R2 Cloud Drop 공유

Cloud share는 R2 S3 호환 API를 사용합니다. 아래 환경 변수를 설정하면 서버 시작 시 자동으로 활성화됩니다.

```env
PONSWARP_CLOUD_ENABLED=true
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
# 선택: R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com

PONSWARP_CLOUD_PREFIX=ponswarp-cloud
PONSWARP_CLOUD_RETENTION_SECONDS=86400
PONSWARP_CLOUD_UPLOAD_URL_TTL_SECONDS=3600
PONSWARP_CLOUD_DOWNLOAD_URL_TTL_SECONDS=300
PONSWARP_CLOUD_CLEANUP_INTERVAL_SECONDS=300
PONSWARP_CLOUD_CLEANUP_RUN_ON_STARTUP=true
PONSWARP_CLOUD_MAX_FILES=100
PONSWARP_CLOUD_MAX_FILE_BYTES=10737418240
PONSWARP_CLOUD_MAX_TOTAL_BYTES=10737418240
```

서버는 만료된 공유를 주기적으로 삭제합니다. 운영 환경에서는 R2 버킷 라이프사이클도 각 플랜의 보관 기간에 맞춰 같이 설정하는 것을 권장합니다.
브라우저가 presigned PUT/GET 요청을 직접 보내므로 R2 버킷 CORS에는 프론트엔드 Origin과 `PUT`, `GET`, `HEAD` 메서드를 허용해야 합니다.
무료 Cloud Drop은 공유 1건당 최대 10GB/24시간입니다. 유료 Drop Pass와 Pro entitlement는 더 큰 용량, 최대 7일 보관, 비밀번호, 다운로드 세션 제한을 적용할 수 있습니다. 앱의 무제한 컨셉은 직접 P2P 전송 경로가 담당하며, Cloud Drop 한도를 넘는 파일은 직접 P2P를 사용하거나 플랜 한도 단위로 분할해야 합니다.

### 운영 안전 설정

명시적으로 Cloud Drop을 켠 상태에서 R2 설정이 불완전하면 서버는 기동에 실패합니다. 유료화 플래그를 켠 상태에서는 Postgres 연결도 필수입니다.

```env
CORS_ORIGINS=https://warp.ponslink.com

# 무료 Cloud Drop은 DB 없이도 R2 manifest fallback으로 동작합니다.
PONSWARP_BILLING_ENABLED=false

# 유료화/권한/사용량 기록을 켤 때 필요합니다.
PONSWARP_PUBLIC_APP_URL=https://warp.ponslink.com
PONSWARP_PUBLIC_API_URL=https://warp.ponslink.com
PONSWARP_DEFAULT_PAYMENT_PROVIDER=lemonsqueezy
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
AUTH_SESSION_SECRET=...
AUTH_SESSION_COOKIE_NAME=ponswarp_session
AUTH_SESSION_TTL_SECONDS=2592000

LEMONSQUEEZY_API_BASE=https://api.lemonsqueezy.com
LEMONSQUEEZY_API_KEY=...
LEMONSQUEEZY_STORE_ID=...
LEMONSQUEEZY_WEBHOOK_SECRET=...
LEMONSQUEEZY_VARIANT_DROP_100GB_3D=...
LEMONSQUEEZY_VARIANT_DROP_500GB_7D=...
LEMONSQUEEZY_VARIANT_DROP_1TB_7D=...
LEMONSQUEEZY_VARIANT_PRO_MONTHLY=...

PAYPAL_API_BASE=https://api-m.paypal.com
PAYPAL_ENV=live
PAYPAL_DEFAULT_CURRENCY=KRW
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...
PAYPAL_PRO_PLAN_ID=...
DATABASE_URL=postgres://ponswarp:password@127.0.0.1:5432/ponswarp
DATABASE_MAX_CONNECTIONS=5
DATABASE_RUN_MIGRATIONS=true
```

`GET /ready`는 운영 헬스체크에 사용할 수 있습니다. `PONSWARP_BILLING_ENABLED=true`일 때는 Postgres와 Lemon Squeezy 또는 PayPal checkout credential 중 하나 이상이 필요합니다. 기본 결제 provider는 Lemon Squeezy이며 `PONSWARP_DEFAULT_PAYMENT_PROVIDER=paypal`로 바꿀 수 있습니다.
유료 Cloud Drop checkout은 Google 로그인 세션이 있어야 시작됩니다. Google Cloud Console의 Web OAuth client에는 승인된 리디렉션 URI로 `https://warp.ponslink.com/auth/google/callback`을 등록해야 합니다. 로컬에서 프론트와 API 포트가 다르면 `PONSWARP_PUBLIC_APP_URL`은 프론트 Origin, `PONSWARP_PUBLIC_API_URL`은 백엔드 Origin으로 둡니다. `AUTH_SESSION_SECRET`은 운영에서 32자 이상의 난수 문자열로 설정하고 Git에 커밋하지 마세요.
Lemon Squeezy webhook URL은 `https://warp.ponslink.com/api/billing/lemonsqueezy/webhook`입니다. `order_created`, `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_expired`, `subscription_paused`, `subscription_resumed` 이벤트를 보내면 Drop Pass와 Pro entitlement 상태가 반영됩니다. PayPal webhook URL은 `https://warp.ponslink.com/api/billing/paypal/webhook`이고 기존 호환 경로로 `https://warp.ponslink.com/api/billing/webhook`도 유지됩니다.

## 메시지 프로토콜

JSON 기반 메시지 프레이밍:

```json
{"type": "JoinRoom", "payload": {"room_id": "abc123"}}
{"type": "Offer", "payload": {"room_id": "abc123", "sdp": "...", "target": null}}
```

## 프론트엔드 통합

`ponswarp/src/services/signaling-adapter.ts` 어댑터를 통해 기존 Socket.io 기반 코드와 호환됩니다.
