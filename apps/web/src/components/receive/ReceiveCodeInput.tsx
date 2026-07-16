"use client";

import { useEffect, useRef, useState } from "react";
import { sanitizeCodeInput } from "@/lib/formatting/code";

type Props = {
  onSubmit: (code: string) => void;
  error?: string | null;
  loading?: boolean;
  className?: string;
};

export function ReceiveCodeInput({ onSubmit, error, loading, className = "" }: Props) {
  const [code, setCode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (code.length === 6 && !loading) onSubmit(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const cells = Array.from({ length: 6 }, (_, i) => code[i] ?? "");

  return (
    <div className={className}>
      <label htmlFor="receive-code" className="block text-center text-lg font-medium text-text-primary">
        전송 코드를 입력하세요
      </label>
      <p className="mt-2 text-center text-sm text-text-secondary">
        상대방에게 받은 6자리 코드로 워프 공간에 접속합니다.
      </p>

      <div className="relative mt-6">
        <div className="pointer-events-none flex justify-center gap-2" aria-hidden>
          {cells.map((ch, i) => (
            <div
              key={i}
              className={`flex h-12 w-10 items-center justify-center rounded-xl border text-lg font-mono ${
                error
                  ? "animate-code-shake border-danger/60 text-danger"
                  : "border-space-border bg-space-panel text-text-primary"
              }`}
            >
              {ch}
            </div>
          ))}
        </div>
        <input
          id="receive-code"
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(sanitizeCodeInput(e.target.value))}
          className="absolute inset-0 cursor-text opacity-0"
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={6}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "code-error" : undefined}
        />
      </div>

      {error ? (
        <p id="code-error" className="mt-3 text-center text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-6 flex justify-center">
        <button
          type="button"
          disabled={code.length < 6 || loading}
          onClick={() => onSubmit(code)}
          className="rounded-full bg-warp-cyan px-6 py-2.5 text-sm font-medium text-space-bg disabled:opacity-40"
        >
          {loading ? "접속 중…" : "워프 공간 접속"}
        </button>
      </div>

    </div>
  );
}
