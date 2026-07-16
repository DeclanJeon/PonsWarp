"use client";

import { formatBytes } from "@/lib/formatting/bytes";
import type { TransferFileItem } from "@/lib/types";

type Props = {
  files: TransferFileItem[];
  className?: string;
};

export function IncomingFilePreview({ files, className = "" }: Props) {
  const total = files.reduce((s, f) => s + f.size, 0);
  return (
    <div className={`glass-panel p-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-text-primary">받을 파일</h3>
        <p className="text-xs text-text-muted">
          {files.length}개 · {formatBytes(total)}
        </p>
      </div>
      <ul className="max-h-56 space-y-2 overflow-y-auto">
        {files.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate text-text-primary">{f.name}</span>
            <span className="shrink-0 text-xs text-text-muted">{formatBytes(f.size)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
