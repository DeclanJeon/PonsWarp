"use client";

import { formatBytes, formatEta, formatSpeed } from "@/lib/formatting/bytes";
import type { TransferFileItem, TransferProgress } from "@/lib/types";

type Props = {
  progress: TransferProgress;
  files: TransferFileItem[];
  className?: string;
};

export function TransferStats({ progress, files, className = "" }: Props) {
  const current = files[progress.currentFileIndex];
  const completed = files.filter((f) => f.state === "completed").length;

  return (
    <div className={`glass-panel space-y-3 p-4 text-sm ${className}`}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-text-muted">현재 속도</p>
          <p className="font-medium text-text-primary">{formatSpeed(progress.currentSpeedBps)}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">평균 속도</p>
          <p className="font-medium text-text-primary">{formatSpeed(progress.averageSpeedBps)}</p>
        </div>
        <div className="col-span-2">
          <p className="text-xs text-text-muted">남은 시간</p>
          <p className="font-medium text-text-primary">{formatEta(progress.etaSeconds)}</p>
        </div>
      </div>
      {current ? (
        <div className="border-t border-space-border pt-3 text-text-secondary">
          <p className="text-xs text-text-muted">
            {files.length}개 중 {progress.currentFileIndex + 1}번째 파일 · 완료 {completed}개
          </p>
          <p className="mt-1 truncate text-text-primary">{current.name}</p>
          <p className="text-xs">
            {formatBytes(progress.currentFileTransferredBytes)} / {formatBytes(progress.currentFileTotalBytes || current.size)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
