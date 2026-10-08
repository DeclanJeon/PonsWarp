# PonsWarp 운영 마무리 보고서 — 2026-10-08

## 범위

이번 기록은 배포 후 Cloudflare HTML 캐시 무효화와 운영 전송 QA 마무리 작업이다. 새 애플리케이션 배포를 수행한 기록은 아니다. 배포 자동화의 purge 경로는 `55c3561` (`Automate production HTML cache purge`)에 포함되어 있다.

## 처리 내역

- 배포 runner의 Cloudflare `CLOUDFLARE_ZONE_ID` 설정을 올바른 zone ID로 수정했다. 이전 값은 account ID였다.
- Cloudflare API로 `https://warp.ponslink.com/` 및 `/index.html` 캐시를 무효화했다.
- purge 후 운영 HTML이 활성 entry asset `/assets/index-WjbPTRdP.js`를 가리키고, 해당 asset이 정상 응답하는 것을 확인했다.
- 운영 전송 smoke test `pnpm --dir PonsWarp run qa:prod-transfer`를 실행했다.

## 검증 결과

| 검증 | 결과 |
|---|---|
| Cloudflare targeted purge | 성공 |
| 운영 HTML의 캐시 상태 | `EXPIRED` (캐시 HIT 아님) |
| 활성 entry asset | `/assets/index-WjbPTRdP.js` 확인 및 응답 성공 |
| 운영 전송 QA | `ok: true` |
| 전송 크기 | 1 MiB |
| 전송 상태 | 진행 이벤트 및 수신 파일 materialization 확인 |

## 자격 증명 위치

배포 스크립트는 로컬 WSL deploy runner에서 실행되며, Cloudflare purge API도 SSH 배포 후 runner에서 호출한다. 토큰은 운영 서버로 복사하지 않는다.

- 설정 파일: `/root/.config/ponswarp/cloudflare.env` (이 WSL 배포 실행 계정의 `$HOME` 기준)
- 권한: owner-only `0600`
- 저장 키: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`
- 토큰/ID 값은 이 문서나 저장소에 기록하지 않는다.
- 운영 서버의 `/home/declan/ponswarp-deploy/secrets/env.production`은 애플리케이션 runtime secret 전용이며 Cloudflare purge 토큰을 두지 않는다.

## 최종 상태

운영 HTML 캐시 무효화와 production transfer QA가 완료됐다. 새 entry asset이 운영에서 확인됐고, 확인한 작업 범위에 남은 항목은 없다.
