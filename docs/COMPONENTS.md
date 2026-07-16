# WarpSpace Components

## Architecture

```
UI (pages/components)
  └─ hooks/useTransferSession
       └─ lib/webrtc/TransferEngine
            ├─ lib/signaling/SignalingClient  →  server/signaling.mjs
            ├─ RTCPeerConnection + DataChannel
            └─ lib/transfer/ProgressTracker
  └─ stores/transfer-store (React UI state, 2–5 Hz)
  └─ stores/motion-store (rAF-interpolated motion snapshot)
  └─ components/warp/* (Canvas + DOM portal visuals)
```

전송 엔진과 UI는 분리되어 있다. 컴포넌트 내부에 WebRTC 로직을 두지 않는다.

## Warp scene

| Component | Role |
|---|---|
| `WarpScene` | 역할별 포털 + 입자 + 연결 상태 래퍼 |
| `BlackHole` | 송신 포털 (accretion disk, event horizon) |
| `WhiteHole` | 수신 포털 (방사형 방출) |
| `WarpParticleCanvas` | Canvas 2D 입자 (진행률/속도 연동) |
| `ConnectionPulse` | 연결 상태 인디케이터 + `aria-live` |

## Transfer

| Component | Role |
|---|---|
| `TransferDashboard` | 송/수신 공통 3열 대시보드 |
| `TransferProgressBar` | 접근 가능한 전체/현재 파일 프로그레스 |
| `TransferStats` | 속도, ETA, 현재 파일 |
| `TransferControls` | 시작/일시정지/재개/재시도 |
| `CompletionPanel` / `TransferErrorPanel` | 완료·오류 CTA |

## Sharing / Upload / Receive

- `WarpDropzone`, `FilePickerButton`, `SelectedFileList`, `UploadSummary`
- `ShareCode`, `ShareLink`, `ShareQrCode`, `WaitingReceiverPanel`
- `ReceiveCodeInput`, `ReceiveConsentPanel`, `IncomingFilePreview`, `SaveDestinationPicker`

## Hooks

- `useTransferSession(role)` — 엔진 생명주기와 store 브리지
- `useMotionIntensity` / `usePrefersReducedMotion`
- `useDevicePerformance` — 입자 예산·DPR 상한
- `useWakeLock` — 전송 중 화면 잠금 방지

## Motion data path

1. `TransferEngine`이 청크마다 `ProgressTracker` 갱신
2. UI 수치는 250ms 간격 store 반영
3. `updateMotionFromTransfer`가 motion external store target 갱신
4. Canvas/`useSyncExternalStore`가 rAF 보간 스냅샷 소비

가짜 프로그레스를 쓰지 않는다. `bytesTransferred / totalBytes`가 모션 density/progress의 소스다.
