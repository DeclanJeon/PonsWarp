"use client";

import { useEffect, useRef } from "react";
import { useTransferStore } from "@/stores/transfer-store";

export function TransferProgressBar() {
  const progressRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const speedRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const unsub = useTransferStore.subscribe((state) => {
      const p = state.progress;
      if (progressRef.current) progressRef.current.style.width = `${Math.min(100, p.progress * 100)}%`;
      if (textRef.current) textRef.current.innerText = `${(p.progress * 100).toFixed(1)}%`;
      if (speedRef.current) {
        const speedMB = (p.currentSpeedBps / (1024 * 1024)).toFixed(2);
        speedRef.current.innerText = `${speedMB} MB/s`;
      }
    });
    return unsub;
  }, []);

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="mb-2 flex justify-between font-mono text-sm text-cyan-400">
        <span className="tracking-wider">TRANSFERRING</span>
        <div className="flex gap-4">
          <span ref={speedRef} className="text-cyan-300">
            0.00 MB/s
          </span>
          <span ref={textRef}>0.0%</span>
        </div>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full border border-gray-700 bg-gray-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          ref={progressRef}
          className="h-full bg-gradient-to-r from-cyan-500 via-blue-500 to-purple-600 shadow-[0_0_10px_rgba(6,182,212,0.8)] transition-all duration-100 ease-linear"
          style={{ width: "0%" }}
        />
      </div>
    </div>
  );
}
