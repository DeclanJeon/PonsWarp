"use client";

import { motion } from "motion/react";
import { useSyncExternalStore } from "react";
import { getMotionSnapshot, subscribeMotion } from "@/stores/motion-store";
import type { MotionIntensity } from "@/lib/types";

type Props = {
  label?: string;
  sublabel?: string;
  intensity?: MotionIntensity;
  className?: string;
};

export function WhiteHole({
  label = "화이트홀 대기 중",
  sublabel = "파일이 여기에 나타납니다",
  intensity = "full",
  className = "",
}: Props) {
  const snap = useSyncExternalStore(subscribeMotion, getMotionSnapshot, getMotionSnapshot);
  const reduced = intensity === "reduced" || snap.intensity === "reduced";
  const off = intensity === "off" || snap.intensity === "off";
  const spin = off ? 0 : reduced ? 48 : 22 / Math.max(0.25, snap.portalIntensity);

  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      <div className="relative aspect-square w-full max-w-[min(100%,420px)]">
        <motion.div
          className="absolute inset-[6%] rounded-full border border-white-hole/25"
          style={{ boxShadow: `0 0 ${36 * snap.portalIntensity}px rgba(223,250,255,${0.12 * snap.portalIntensity})` }}
          animate={off ? undefined : { rotate: -360, scale: [1, 1.03, 1] }}
          transition={
            off
              ? undefined
              : {
                  rotate: { duration: spin * 1.4, repeat: Infinity, ease: "linear" },
                  scale: { duration: 3.2, repeat: Infinity, ease: "easeInOut" },
                }
          }
        />

        <motion.div
          className="absolute inset-[16%] rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(223,250,255,0.55) 0%, rgba(56,189,248,0.2) 35%, rgba(34,211,238,0.08) 55%, transparent 70%)",
            filter: reduced || off ? "blur(2px)" : "blur(8px)",
            opacity: 0.4 + snap.portalIntensity * 0.5,
          }}
          animate={off ? undefined : { scale: [0.92, 1.05, 0.92] }}
          transition={off ? undefined : { duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
        />

        <div
          className="absolute inset-[30%] rounded-full"
          style={{
            background: "radial-gradient(circle, rgba(255,255,255,0.85), rgba(223,250,255,0.25) 45%, transparent 70%)",
            opacity: 0.35 + snap.progress * 0.45,
          }}
        />

        <motion.div
          className="absolute inset-[20%] rounded-full border border-warp-cyan/20"
          animate={off ? undefined : { rotate: 360 }}
          transition={off ? undefined : { duration: spin, repeat: Infinity, ease: "linear" }}
        />

        <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
          <p className="max-w-[14rem] text-base font-medium text-text-primary sm:text-lg">{label}</p>
          {sublabel ? <p className="mt-2 max-w-[16rem] text-xs text-text-secondary sm:text-sm">{sublabel}</p> : null}
        </div>
      </div>
    </div>
  );
}
