"use client";

import { useState } from "react";
import { formatCodeDisplay } from "@/lib/formatting/bytes";

type Props = {
  code: string;
  className?: string;
};

export function ShareCode({ code, className = "" }: Props) {
  const [copied, setCopied] = useState(false);
  const display = formatCodeDisplay(code);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code.replace(/\s/g, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className={`glass-panel p-4 ${className}`}>
      <p className="text-xs uppercase tracking-[0.2em] text-text-muted">전송 코드</p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="font-mono text-3xl font-semibold tracking-[0.2em] text-text-primary sm:text-4xl" aria-label={`전송 코드 ${display}`}>
          {display}
        </p>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-full border border-space-border px-3 py-1.5 text-xs text-text-secondary hover:bg-white/5"
        >
          {copied ? "복사되었습니다" : "코드 복사"}
        </button>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied ? "코드가 클립보드에 복사되었습니다" : ""}
      </span>
    </div>
  );
}
