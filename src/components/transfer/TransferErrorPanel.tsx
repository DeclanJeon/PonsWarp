"use client";

type Props = {
  message: string;
  code?: string | null;
  onRetry?: () => void;
  onHome?: () => void;
  className?: string;
};

export function TransferErrorPanel({ message, code, onRetry, onHome, className = "" }: Props) {
  return (
    <div className={`glass-panel space-y-3 p-5 ${className}`} role="alert">
      <h2 className="text-lg font-medium text-text-primary">문제가 발생했습니다</h2>
      <p className="text-sm text-text-secondary">{message}</p>
      {code ? (
        <details className="text-xs text-text-muted">
          <summary className="cursor-pointer">기술 상세</summary>
          <p className="mt-1 font-mono">{code}</p>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-1">
        {onRetry ? (
          <button type="button" onClick={onRetry} className="rounded-full bg-warp-violet px-4 py-2 text-sm text-white">
            다시 시도
          </button>
        ) : null}
        {onHome ? (
          <button
            type="button"
            onClick={onHome}
            className="rounded-full border border-space-border px-4 py-2 text-sm text-text-secondary"
          >
            홈으로
          </button>
        ) : null}
      </div>
    </div>
  );
}
