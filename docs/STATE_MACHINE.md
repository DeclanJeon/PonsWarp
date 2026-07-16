# Transfer View State Machine

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> files_selected: select files
  files_selected --> creating_session: create session
  creating_session --> waiting_receiver: session-created
  waiting_receiver --> receiver_joined: peer-joined
  receiver_joined --> negotiating: RTC offer/answer
  negotiating --> ready: datachannel open
  ready --> transferring: start-transfer
  transferring --> paused: pause
  paused --> transferring: resume
  transferring --> verifying: file complete hash
  verifying --> transferring: next file
  verifying --> completed: all files done
  transferring --> reconnecting: peer disconnect
  reconnecting --> transferring: recovered
  reconnecting --> failed: give up
  waiting_receiver --> expired: TTL
  negotiating --> failed: reject/error
  ready --> failed: reject
  transferring --> failed: fatal error
  completed --> [*]
  failed --> [*]
  expired --> [*]
```

## State → UI mapping

| State | Portal | Particles | Progress UI | Primary CTA |
|---|---|---|---|---|
| idle | low spin | sparse | hidden | 파일 선택 |
| files-selected | low spin | sparse | hidden | 전송 공간 만들기 |
| creating-session / waiting-receiver | waiting | medium | hidden | 코드/QR 공유 |
| receiver-joined / negotiating | unstable | rising | hidden | — |
| ready | stable high | medium | hidden | 워프 시작 / 파일 받기 |
| transferring | max | speed-mapped | shown | 일시정지 |
| paused | dim | frozen | shown | 재개 |
| reconnecting | unstable low | weak | shown (held) | 다시 연결 |
| verifying | medium | low | shown | — |
| completed | calm | sparse | 100% | 추가/종료 |
| failed / expired | static warn | stopped | held | 재시도/홈 |

## Connection mode labels

- `direct` → 보안 연결 완료 / 직접 연결됨
- `relay` → 안정적인 중계 경로로 연결되었습니다
- TURN 미설정 시 STUN only (로컬/동일 NAT에서는 직접 연결 가능)
