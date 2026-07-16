"use client";

import { formatBytes, formatPercent } from "@/lib/formatting/bytes";
import type { TransferProgress as Progress } from "@/lib/types";

type Props = {
  progress: Progress;
  className?: string;
};

export function TransferProgressBar({ progress, className = "" }: Props) {
  const value = Math.round(progress.progress * 1000) / 10;

  return (
    <div className={className}>
      <div className="mb-2 flex items-end justify-between gap-3">
        <p className="text-3xl font-semibold tabular-nums text-text-primary">{formatPercent(progress.progress)}</p>
        <p className="text-sm text-text-secondary">
          {formatBytes(progress.transferredBytes)} / {formatBytes(progress.totalBytes)}
        </p>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
        aria-label="전체 전송 진행률"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-warp-violet via-warp-blue to-warp-cyan transition-[width] duration-300"
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
      {progress.currentFileTotalBytes > 0 ? (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-xs text-text-muted">
            <span>현재 파일</span>
            <span>
              {formatBytes(progress.currentFileTransferredBytes)} / {formatBytes(progress.currentFileTotalBytes)}
            </span>
          </div>
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-white/8"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(
              progress.currentFileTotalBytes
                ? (progress.currentFileTransferredBytes / progress.currentFileTotalBytes) * 100
                : 0,
            )}
            aria-label="현재 파일 진행률"
          >
            <div
              className="h-full rounded-full bg-warp-cyan/80 transition-[width] duration-300"
              style={{
                width: `${Math.min(
                  100,
                  progress.currentFileTotalBytes
                    ? (progress.currentFileTransferredBytes / progress.currentFileTotalBytes) * 100
                    : 0,
                )}%`,
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
