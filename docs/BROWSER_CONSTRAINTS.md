# Browser Constraints

## WebRTC / networking

- 시그널링은 WebSocket (`server/signaling.mjs`, 기본 `ws://localhost:4001`).
- ICE: 공개 Google STUN 기본. TURN은 `NEXT_PUBLIC_TURN_*` 환경변수로 설정.
- Symmetric NAT / 기업망에서는 TURN 없으면 연결 실패 가능.
- DataChannel은 ordered + 64KiB 청크 + `bufferedAmount` backpressure.

## Storage

| API | 용도 | 지원 |
|---|---|---|
| File System Access `showDirectoryPicker` | 수신 폴더 스트리밍 저장 | Chromium 계열 |
| Blob download (`<a download>`) | 기본 fallback | 대부분 브라우저 |
| StreamSaver | 대용량 스트리밍 fallback | 선택적 (의존성 포함, 기본 경로 아님) |

Safari/iOS는 FS Access 미지원 → Blob 다운로드. 사용자 제스처 없이 자동 다운로드가 막히므로 **수신 동의 버튼 이후**에만 저장한다.

## Background / mobile

- 백그라운드 탭에서 타이머·WebRTC 스로틀 가능.
- iOS가 화면 잠그면 전송 중단될 수 있음 → Wake Lock + 경고 카피.
- 저사양/모바일: 입자 수·DPR 자동 감소 (`useDevicePerformance`).

## Accessibility

- 키보드 파일 선택 버튼 필수 (DnD 전용 금지).
- `role="progressbar"` + `aria-valuenow`.
- 상태: `aria-live="polite"`, 오류: `role="alert"`.
- `prefers-reduced-motion` 및 앱 설정 `전체/줄임/끔`.

## Security / privacy

- 파일 바이트는 시그널링 서버를 거치지 않음 (메타데이터·SDP·ICE만).
- TURN 릴레이 사용 시 중계 서버가 암호화된 패킷을 전달할 수 있음 → 카피: “중앙 파일 저장소를 거치지 않습니다”.
- 세션 코드 TTL 기본 30분.

## Known limits (P0)

- 재연결은 UI 상태 유지 + 안내 수준 (풀 ICE restart 재전송은 P1).
- 100% 수신 후 Blob 단위 저장 (완전 스트리밍 writer는 FS Access 경로에서만).
- 송신 추가 파일은 새 세션 권장 (진행 중 renegotiation 미구현).
