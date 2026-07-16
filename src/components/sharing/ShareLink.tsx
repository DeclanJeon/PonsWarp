"use client";

import { useState } from "react";

type Props = {
  url: string;
  className?: string;
};

export function ShareLink({ url, className = "" }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className={`glass-panel p-4 ${className}`}>
      <p className="text-xs text-text-muted">공유 링크</p>
      <div className="mt-2 flex items-center gap-2">
        <a
          href={url}
          className="min-w-0 flex-1 truncate text-sm text-warp-blue hover:underline"
          target="_blank"
          rel="noreferrer"
        >
          {url}
        </a>
        <button
          type="button"
          onClick={() => void copy()}
          className="shrink-0 rounded-full border border-space-border px-3 py-1.5 text-xs text-text-secondary hover:bg-white/5"
        >
          {copied ? "복사됨" : "링크 복사"}
        </button>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied ? "링크가 클립보드에 복사되었습니다" : ""}
      </span>
    </div>
  );
}
