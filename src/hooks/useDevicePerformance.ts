"use client";

import { useEffect, useState } from "react";

export type DeviceTier = "high" | "medium" | "low";

export type DevicePerformance = {
  tier: DeviceTier;
  particleBudget: number;
  dprCap: number;
};

function detect(): DevicePerformance {
  if (typeof window === "undefined") {
    return { tier: "medium", particleBudget: 120, dprCap: 1.5 };
  }

  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  const isMobile = /Mobi|Android/i.test(navigator.userAgent);

  if (saveData || cores <= 4 || memory <= 2 || isMobile) {
    return { tier: "low", particleBudget: 48, dprCap: 1.25 };
  }
  if (cores <= 8 || memory <= 4) {
    return { tier: "medium", particleBudget: 100, dprCap: 1.5 };
  }
  return { tier: "high", particleBudget: 160, dprCap: 2 };
}

export function useDevicePerformance(): DevicePerformance {
  const [perf, setPerf] = useState<DevicePerformance>({ tier: "medium", particleBudget: 120, dprCap: 1.5 });

  useEffect(() => {
    setPerf(detect());
  }, []);

  return perf;
}
