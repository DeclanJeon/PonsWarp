"use client";

import { formatBytes, formatPercent } from "@/lib/formatting/bytes";
import type { TransferFileItem } from "@/lib/types";

type Props = {
  files: TransferFileItem[];
  onRemove?: (id: string) => void;
  className?: string;
};

function stateIcon(state: TransferFileItem["state"]): string {
  switch (state) {
    case "completed":
      return "✓";
    case "transferring":
    case "preparing":
      return "↗";
    case "verifying":
      return "…";
    case "failed":
      return "!";
    case "skipped":
      return "–";
    default:
      return "·";
  }
}

function stateLabel(file: TransferFileItem): string {
  switch (file.state) {
    case "queued":
      return "대기 중";
    case "preparing":
      return "준비 중";
    case "transferring":
      return formatPercent(file.progress);
    case "verifying":
      return "확인 중";
    case "completed":
      return "완료";
    case "failed":
      return file.error || "실패";
    case "skipped":
      return "건너뜀";
    default:
      return "";
  }
}

export function SelectedFileList({ files, onRemove, className = "" }: Props) {
  if (!files.length) {
    return (
      <div className={`glass-panel p-4 text-sm text-text-muted ${className}`}>선택된 파일이 없습니다.</div>
    );
  }

  const total = files.reduce((s, f) => s + f.size, 0);

  return (
    <div className={`glass-panel flex max-h-[420px] flex-col ${className}`}>
      <div className="flex items-center justify-between border-b border-space-border px-4 py-3">
        <h2 className="text-sm font-medium text-text-primary">파일 목록</h2>
        <p className="text-xs text-text-muted">
          {files.length}개 · {formatBytes(total)}
        </p>
      </div>
      <ul className="flex-1 space-y-1 overflow-y-auto p-2" aria-label="전송 파일 목록">
        {files.map((file) => (
          <li
            key={file.id}
            className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm ${
              file.state === "transferring" ? "bg-warp-violet/10" : "hover:bg-white/3"
            }`}
          >
            <span className="w-4 text-center text-text-secondary" aria-hidden>
              {stateIcon(file.state)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-text-primary">{file.name}</p>
              <p className="text-xs text-text-muted">
                {formatBytes(file.size)}
                {file.state === "transferring" ? ` · ${formatBytes(file.transferredBytes)}` : ""}
                {` · ${stateLabel(file)}`}
              </p>
            </div>
            {onRemove && file.state === "queued" ? (
              <button
                type="button"
                className="rounded-lg px-2 py-1 text-xs text-text-muted hover:bg-white/5 hover:text-text-primary"
                onClick={() => onRemove(file.id)}
                aria-label={`${file.name} 제거`}
              >
                삭제
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
