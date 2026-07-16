"use client";

import { IncomingFilePreview } from "@/components/receive/IncomingFilePreview";
import { formatBytes } from "@/lib/formatting/bytes";
import type { TransferFileItem } from "@/lib/types";

type Props = {
  files: TransferFileItem[];
  senderLabel?: string;
  onAccept: () => void;
  onReject: () => void;
  onPickDirectory?: () => void;
  directoryLabel?: string | null;
  className?: string;
};

export function ReceiveConsentPanel({
  files,
  senderLabel = "익명 기기",
  onAccept,
  onReject,
  onPickDirectory,
  directoryLabel,
  className = "",
}: Props) {
  const total = files.reduce((s, f) => s + f.size, 0);
  const large = total >= 500 * 1024 * 1024;

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="glass-panel p-4">
        <p className="text-xs text-text-muted">송신자</p>
        <p className="text-text-primary">{senderLabel}</p>
        <p className="mt-2 text-sm text-text-secondary">
          {files.length}개 파일 · 총 {formatBytes(total)}
        </p>
        {directoryLabel ? <p className="mt-1 text-xs text-text-muted">저장 위치: {directoryLabel}</p> : null}
      </div>

      <IncomingFilePreview files={files} />

      {large ? (
        <p className="text-xs text-warning">
          전송 중에는 이 페이지를 닫지 마세요.
          <span className="mt-1 block text-text-muted">
            화면이 잠기거나 브라우저가 백그라운드로 이동하면 전송이 일시 중단될 수 있습니다.
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onAccept}
          className="rounded-full bg-warp-cyan px-5 py-2.5 text-sm font-medium text-space-bg"
        >
          파일 받기
        </button>
        {onPickDirectory ? (
          <button
            type="button"
            onClick={onPickDirectory}
            className="rounded-full border border-space-border px-4 py-2 text-sm text-text-secondary hover:bg-white/5"
          >
            저장 위치 선택
          </button>
        ) : null}
        <button
          type="button"
          onClick={onReject}
          className="rounded-full border border-space-border px-4 py-2 text-sm text-text-secondary hover:bg-white/5"
        >
          거절하고 나가기
        </button>
      </div>
    </div>
  );
}
