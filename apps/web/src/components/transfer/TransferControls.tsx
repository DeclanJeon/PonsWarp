"use client";

import type { TransferViewState } from "@/lib/types";

type Props = {
  role: "sender" | "receiver";
  viewState: TransferViewState;
  onStart?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  onNewSession?: () => void;
  className?: string;
};

export function TransferControls({
  role,
  viewState,
  onStart,
  onPause,
  onResume,
  onRetry,
  onNewSession,
  className = "",
}: Props) {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {role === "sender" && viewState === "ready" ? (
        <button
          type="button"
          onClick={onStart}
          className="rounded-full bg-warp-violet px-5 py-2.5 text-sm font-medium text-white hover:bg-warp-violet/90"
        >
          워프 시작
        </button>
      ) : null}

      {role === "sender" && viewState === "transferring" && onPause ? (
        <button
          type="button"
          onClick={onPause}
          className="rounded-full border border-space-border px-4 py-2 text-sm text-text-secondary hover:bg-white/5"
        >
          일시정지
        </button>
      ) : null}

      {role === "sender" && viewState === "paused" && onResume ? (
        <button
          type="button"
          onClick={onResume}
          className="rounded-full bg-warp-blue px-4 py-2 text-sm font-medium text-space-bg hover:bg-warp-blue/90"
        >
          재개
        </button>
      ) : null}

      {(viewState === "failed" || viewState === "reconnecting") && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full border border-space-border px-4 py-2 text-sm text-text-secondary hover:bg-white/5"
        >
          다시 연결
        </button>
      ) : null}

      {(viewState === "completed" || viewState === "failed" || viewState === "expired") && onNewSession ? (
        <button
          type="button"
          onClick={onNewSession}
          className="rounded-full border border-space-border px-4 py-2 text-sm text-text-secondary hover:bg-white/5"
        >
          새 전송 공간 만들기
        </button>
      ) : null}
    </div>
  );
}
