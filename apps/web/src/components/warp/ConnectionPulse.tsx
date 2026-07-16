"use client";

import type { TransferViewState } from "@/lib/types";
import { statusLabel } from "@/lib/motion/motion-map";

type Props = {
  state: TransferViewState;
  connectionMode?: "direct" | "relay" | "unknown";
  className?: string;
};

function indicatorClass(state: TransferViewState): string {
  switch (state) {
    case "waiting-receiver":
    case "creating-session":
      return "bg-warp-blue animate-pulse";
    case "negotiating":
    case "receiver-joined":
      return "bg-warning animate-spin border-2 border-warning/30 border-t-warning";
    case "ready":
      return "bg-success";
    case "transferring":
      return "bg-warp-cyan shadow-[0_0_8px_rgba(34,211,238,0.7)]";
    case "reconnecting":
      return "bg-warning animate-pulse";
    case "failed":
    case "expired":
      return "bg-danger";
    case "completed":
      return "bg-success";
    case "paused":
      return "bg-text-muted";
    default:
      return "bg-text-muted";
  }
}

export function ConnectionPulse({ state, connectionMode = "unknown", className = "" }: Props) {
  const label = statusLabel(state, connectionMode);
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border border-space-border bg-space-panel/80 px-3 py-1.5 text-sm text-text-secondary ${className}`}
      role="status"
      aria-live="polite"
    >
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${indicatorClass(state)}`} aria-hidden />
      <span>{label}</span>
      {connectionMode === "relay" && (state === "ready" || state === "transferring") ? (
        <span className="text-xs text-text-muted">· 중계</span>
      ) : null}
      {connectionMode === "direct" && (state === "ready" || state === "transferring") ? (
        <span className="text-xs text-text-muted">· 직접</span>
      ) : null}
    </div>
  );
}
