"use client";

import { useEffect, useRef } from "react";

export function useWakeLock(enabled: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    let active = true;

    const request = async () => {
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (!active) {
          await sentinel.release();
          return;
        }
        sentinelRef.current = sentinel;
      } catch {
        /* unsupported / denied */
      }
    };

    void request();

    const onVisibility = () => {
      if (document.visibilityState === "visible" && enabled) void request();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinelRef.current?.release();
      sentinelRef.current = null;
    };
  }, [enabled]);
}
