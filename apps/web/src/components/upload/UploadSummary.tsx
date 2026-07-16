"use client";

import { formatBytes } from "@/lib/formatting/bytes";
import type { TransferFileItem } from "@/lib/types";

type Props = {
  files: TransferFileItem[];
  className?: string;
};

export function UploadSummary({ files, className = "" }: Props) {
  const total = files.reduce((s, f) => s + f.size, 0);
  return (
    <div className={`text-sm text-text-secondary ${className}`}>
      <span className="text-text-primary">{files.length}개 파일</span>이 선택되었습니다
      <span className="mx-2 text-text-muted">·</span>
      총 <span className="text-text-primary">{formatBytes(total)}</span>
    </div>
  );
}
