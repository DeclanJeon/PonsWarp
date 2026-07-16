"use client";

import { useCallback, useState } from "react";
import { WarpScene } from "@/components/warp/WarpScene";
import { FilePickerButton } from "@/components/upload/FilePickerButton";
import { formatBytes } from "@/lib/formatting/bytes";
import type { TransferViewState } from "@/lib/types";

type Props = {
  onFiles: (files: File[]) => void;
  viewState?: TransferViewState;
  className?: string;
};

export function WarpDropzone({ onFiles, viewState = "idle", className = "" }: Props) {
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<{ count: number; bytes: number } | null>(null);

  const handleFiles = useCallback(
    (files: File[]) => {
      setDragging(false);
      setPreview(null);
      if (files.length) onFiles(files);
    },
    [onFiles],
  );

  return (
    <div
      className={className}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
        const items = e.dataTransfer?.items;
        if (items?.length) {
          // best-effort preview; sizes unavailable until drop
          setPreview({ count: items.length, bytes: 0 });
        }
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
        setPreview(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) {
          setPreview({ count: files.length, bytes: files.reduce((s, f) => s + f.size, 0) });
        }
        handleFiles(files);
      }}
    >
      <WarpScene
        role="sender"
        viewState={viewState}
        dragging={dragging}
        title={dragging ? "여기에 놓아 워프 시작" : undefined}
        subtitle={
          dragging && preview
            ? preview.bytes > 0
              ? `${preview.count}개 파일 · ${formatBytes(preview.bytes)}`
              : `${preview.count}개 파일`
            : undefined
        }
      >
        <div className="flex flex-col items-center gap-3">
          <FilePickerButton onFiles={handleFiles} />
          <p className="text-center text-xs text-text-muted">
            단일 파일과 여러 파일을 전송할 수 있습니다.
            <br />
            중앙 파일 저장소를 거치지 않고 기기 간 직접 전송됩니다.
          </p>
        </div>
      </WarpScene>
    </div>
  );
}
