"use client";

import { WarpScene } from "@/components/warp/WarpScene";
import { SelectedFileList } from "@/components/upload/SelectedFileList";
import { WaitingReceiverPanel } from "@/components/sharing/WaitingReceiverPanel";
import { TransferProgressBar } from "@/components/transfer/TransferProgress";
import { TransferStats } from "@/components/transfer/TransferStats";
import { TransferControls } from "@/components/transfer/TransferControls";
import { CompletionPanel } from "@/components/transfer/CompletionPanel";
import { TransferErrorPanel } from "@/components/transfer/TransferErrorPanel";
import { useTransferStore } from "@/stores/transfer-store";
import { useWakeLock } from "@/hooks/useWakeLock";

type Props = {
  onStart?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  onNewSession?: () => void;
  onEnd?: () => void;
  onAddMore?: () => void;
};

export function TransferDashboard({
  onStart,
  onPause,
  onResume,
  onRetry,
  onNewSession,
  onEnd,
  onAddMore,
}: Props) {
  const role = useTransferStore((s) => s.role) ?? "sender";
  const viewState = useTransferStore((s) => s.viewState);
  const files = useTransferStore((s) => s.files);
  const progress = useTransferStore((s) => s.progress);
  const code = useTransferStore((s) => s.code);
  const shareUrl = useTransferStore((s) => s.shareUrl);
  const expiresAt = useTransferStore((s) => s.expiresAt);
  const connectionMode = useTransferStore((s) => s.connectionMode);
  const errorMessage = useTransferStore((s) => s.errorMessage);
  const errorCode = useTransferStore((s) => s.errorCode);
  const receivedBlobs = useTransferStore((s) => s.receivedBlobs);

  useWakeLock(viewState === "transferring" || viewState === "verifying");

  const showProgress =
    viewState === "transferring" ||
    viewState === "paused" ||
    viewState === "verifying" ||
    viewState === "completed" ||
    viewState === "reconnecting";

  return (
    <div className="mx-auto grid w-full max-w-[1440px] gap-4 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
      {/* Left / files */}
      <aside className="order-3 space-y-3 lg:order-1">
        <SelectedFileList files={files} />
        {showProgress ? <TransferStats progress={progress} files={files} className="hidden lg:block" /> : null}
      </aside>

      {/* Center visual */}
      <main className="order-1 space-y-4 lg:order-2">
        <WarpScene role={role} viewState={viewState} connectionMode={connectionMode} compact className="min-h-[36vh] lg:min-h-[52vh]" />

        {showProgress ? (
          <div className="glass-panel p-4">
            <TransferProgressBar progress={progress} />
          </div>
        ) : null}

        <TransferControls
          role={role}
          viewState={viewState}
          onStart={onStart}
          onPause={onPause}
          onResume={onResume}
          onRetry={onRetry}
          onNewSession={onNewSession}
        />

        {viewState === "completed" ? (
          <CompletionPanel
            role={role}
            receivedFiles={receivedBlobs}
            onAddMore={onAddMore}
            onNewSession={onNewSession}
            onEnd={onEnd}
          />
        ) : null}

        {(viewState === "failed" || viewState === "expired") && errorMessage ? (
          <TransferErrorPanel message={errorMessage} code={errorCode} onRetry={onRetry} onHome={onEnd} />
        ) : null}

        {showProgress ? <TransferStats progress={progress} files={files} className="lg:hidden" /> : null}
      </main>

      {/* Right / share */}
      <aside className="order-2 space-y-3 lg:order-3">
        {role === "sender" && code && shareUrl ? (
          <WaitingReceiverPanel code={code} shareUrl={shareUrl} expiresAt={expiresAt} />
        ) : (
          <div className="glass-panel p-4 text-sm text-text-secondary">
            {role === "receiver"
              ? "송신자와 연결되면 파일이 화이트홀을 통해 도착합니다."
              : "전송 공간을 만들면 공유 코드가 표시됩니다."}
          </div>
        )}
        {viewState === "transferring" || viewState === "verifying" ? (
          <p className="text-xs text-warning">
            전송 중에는 이 페이지를 닫지 마세요.
            <span className="mt-1 block text-text-muted">
              화면이 잠기거나 브라우저가 백그라운드로 이동하면 전송이 일시 중단될 수 있습니다.
            </span>
          </p>
        ) : null}
      </aside>
    </div>
  );
}
