import type { ConnectionState, TransferViewState, WarpMotionParams } from "@/lib/types";

const BASE: Record<string, Omit<WarpMotionParams, "mode">> = {
  idle: { portalIntensity: 0.25, particleSpeed: 0.1, particleDensity: 0.15, unstable: false },
  waiting: { portalIntensity: 0.4, particleSpeed: 0.2, particleDensity: 0.25, unstable: false },
  connecting: { portalIntensity: 0.65, particleSpeed: 0.4, particleDensity: 0.4, unstable: true },
  ready: { portalIntensity: 0.8, particleSpeed: 0.35, particleDensity: 0.5, unstable: false },
  transferring: { portalIntensity: 1, particleSpeed: 0.7, particleDensity: 0.85, unstable: false },
  paused: { portalIntensity: 0.45, particleSpeed: 0, particleDensity: 0.3, unstable: false },
  reconnecting: { portalIntensity: 0.35, particleSpeed: 0.08, particleDensity: 0.2, unstable: true },
  completed: { portalIntensity: 0.55, particleSpeed: 0.05, particleDensity: 0.1, unstable: false },
  failed: { portalIntensity: 0.3, particleSpeed: 0, particleDensity: 0.12, unstable: false },
  verifying: { portalIntensity: 0.7, particleSpeed: 0.15, particleDensity: 0.35, unstable: false },
};

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function viewStateToMotionKey(state: TransferViewState): keyof typeof BASE {
  switch (state) {
    case "idle":
    case "files-selected":
      return "idle";
    case "creating-session":
    case "waiting-receiver":
      return "waiting";
    case "receiver-joined":
    case "negotiating":
      return "connecting";
    case "ready":
      return "ready";
    case "transferring":
      return "transferring";
    case "paused":
      return "paused";
    case "reconnecting":
      return "reconnecting";
    case "verifying":
      return "verifying";
    case "completed":
      return "completed";
    case "failed":
    case "expired":
      return "failed";
    default:
      return "idle";
  }
}

export function connectionToViewHint(state: ConnectionState): TransferViewState {
  switch (state) {
    case "waiting":
      return "waiting-receiver";
    case "signaling":
    case "connecting":
      return "negotiating";
    case "connected":
      return "ready";
    case "transferring":
      return "transferring";
    case "paused":
      return "paused";
    case "reconnecting":
      return "reconnecting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

export function getWarpMotionParams(
  viewState: TransferViewState,
  role: "sender" | "receiver" | "idle",
  speedBps = 0,
  bufferedRatio = 0,
): WarpMotionParams {
  const key = viewStateToMotionKey(viewState);
  const base = BASE[key] ?? BASE.idle!;
  const mode = role === "receiver" ? "whitehole" : role === "sender" ? "blackhole" : "idle";

  if (key === "transferring") {
    const normalizedSpeed = clamp(speedBps / (12 * 1024 * 1024), 0.15, 1);
    const density = clamp(0.45 + bufferedRatio * 0.55, 0.3, 1);
    return {
      mode,
      portalIntensity: 1,
      particleSpeed: normalizedSpeed,
      particleDensity: density,
      unstable: false,
    };
  }

  return { ...base, mode };
}

export function statusLabel(state: TransferViewState, connectionMode: "direct" | "relay" | "unknown" = "unknown"): string {
  switch (state) {
    case "idle":
      return "대기 중";
    case "files-selected":
      return "파일 선택됨";
    case "creating-session":
      return "전송 공간을 준비하고 있습니다";
    case "waiting-receiver":
      return "상대방의 접속을 기다리고 있습니다";
    case "receiver-joined":
      return "수신자가 워프 공간에 접속했습니다";
    case "negotiating":
      return "기기 간 직접 연결을 설정하고 있습니다";
    case "ready":
      return connectionMode === "relay" ? "안정적인 중계 경로로 연결되었습니다" : "보안 연결 완료";
    case "transferring":
      return "파일이 이동하고 있습니다";
    case "paused":
      return "전송 일시정지됨";
    case "reconnecting":
      return "전송 상태를 유지한 채 다시 연결하고 있습니다";
    case "verifying":
      return "파일이 올바르게 도착했는지 확인하고 있습니다";
    case "completed":
      return "모든 파일이 도착했습니다";
    case "failed":
      return "연결에 문제가 발생했습니다";
    case "expired":
      return "이 전송 공간은 만료되었습니다";
    default:
      return "";
  }
}
