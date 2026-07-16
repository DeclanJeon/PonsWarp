"use client";

import { useEffect, useState } from "react";
import { useTransferStore } from "@/stores/transfer-store";
import type { MotionIntensity } from "@/lib/types";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return reduced;
}

export function useMotionIntensity(): MotionIntensity {
  const storeIntensity = useTransferStore((s) => s.motionIntensity);
  const prefersReduced = usePrefersReducedMotion();
  if (storeIntensity !== "full") return storeIntensity;
  return prefersReduced ? "reduced" : "full";
}
