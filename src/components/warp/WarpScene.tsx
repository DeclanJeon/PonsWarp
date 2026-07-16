"use client";

import { BlackHole } from "@/components/warp/BlackHole";
import { WhiteHole } from "@/components/warp/WhiteHole";
import { WarpParticleCanvas } from "@/components/warp/WarpParticleCanvas";
import { ConnectionPulse } from "@/components/warp/ConnectionPulse";
import { useMotionIntensity } from "@/hooks/useReducedMotion";
import type { PeerConnectionMode, Role, TransferViewState } from "@/lib/types";

type Props = {
  role?: Role | "idle";
  viewState: TransferViewState;
  connectionMode?: PeerConnectionMode;
  title?: string;
  subtitle?: string;
  dragging?: boolean;
  compact?: boolean;
  children?: React.ReactNode;
  className?: string;
};

export function WarpScene({
  role = "idle",
  viewState,
  connectionMode = "unknown",
  title,
  subtitle,
  dragging = false,
  compact = false,
  children,
  className = "",
}: Props) {
  const intensity = useMotionIntensity();
  const isReceiver = role === "receiver";

  const defaultTitle = isReceiver
    ? viewState === "completed"
      ? "모든 파일을 받았습니다"
      : viewState === "transferring"
        ? "파일이 도착하고 있습니다"
        : "화이트홀 대기 중"
    : viewState === "completed"
      ? "모든 파일이 도착했습니다"
      : viewState === "transferring"
        ? "파일이 워프 중입니다"
        : dragging
          ? "여기에 놓아 워프 시작"
          : "파일을 워프시켜 보세요";

  const defaultSubtitle = isReceiver
    ? viewState === "transferring"
      ? "화이트홀에서 파일이 조립됩니다"
      : "상대 기기와 연결되면 전송이 시작됩니다"
    : dragging
      ? undefined
      : viewState === "idle" || viewState === "files-selected"
        ? "파일을 이곳에 끌어놓거나 선택하세요"
        : undefined;

  return (
    <div className={`relative overflow-hidden rounded-3xl border border-space-border bg-space-surface/40 ${className}`}>
      <div className="starfield absolute inset-0 opacity-60" />
      <WarpParticleCanvas className="absolute inset-0 h-full w-full" intensity={intensity} />

      <div className={`relative z-10 flex flex-col items-center justify-center ${compact ? "min-h-[32vh] py-4" : "min-h-[48vh] py-8"} px-4`}>
        <ConnectionPulse state={viewState} connectionMode={connectionMode} className="mb-4" />

        {isReceiver ? (
          <WhiteHole label={title ?? defaultTitle} sublabel={subtitle ?? defaultSubtitle} intensity={intensity} className={compact ? "w-[70%]" : "w-full"} />
        ) : (
          <BlackHole
            label={title ?? defaultTitle}
            sublabel={subtitle ?? defaultSubtitle}
            dragging={dragging}
            intensity={intensity}
            className={compact ? "w-[70%]" : "w-full"}
          />
        )}

        {children ? <div className="mt-4 w-full max-w-md">{children}</div> : null}
      </div>
    </div>
  );
}
