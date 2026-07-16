"use client";

import { motion } from "motion/react";
import { useSyncExternalStore } from "react";
import { getMotionSnapshot, subscribeMotion } from "@/stores/motion-store";
import type { MotionIntensity } from "@/lib/types";

type Props = {
  label?: string;
  sublabel?: string;
  dragging?: boolean;
  intensity?: MotionIntensity;
  className?: string;
};

export function BlackHole({
  label = "파일을 워프시켜 보세요",
  sublabel = "파일을 이곳에 끌어놓거나 선택하세요",
  dragging = false,
  intensity = "full",
  className = "",
}: Props) {
  const snap = useSyncExternalStore(subscribeMotion, getMotionSnapshot, getMotionSnapshot);
  const reduced = intensity === "reduced" || snap.intensity === "reduced";
  const off = intensity === "off" || snap.intensity === "off";
  const spin = off ? 0 : reduced ? 40 : 18 / Math.max(0.25, snap.portalIntensity);
  const scale = dragging ? 1.08 : 1 + snap.portalIntensity * 0.04;

  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      <motion.div
        className="relative aspect-square w-full max-w-[min(100%,420px)]"
        animate={{ scale }}
        transition={{ type: "spring", stiffness: 120, damping: 18 }}
      >
        {/* outer energy ring */}
        <motion.div
          className="absolute inset-[4%] rounded-full border border-warp-violet/30"
          style={{ boxShadow: `0 0 ${40 * snap.portalIntensity}px rgba(139,92,246,${0.15 * snap.portalIntensity})` }}
          animate={off ? undefined : { rotate: 360 }}
          transition={off ? undefined : { duration: spin * 1.6, repeat: Infinity, ease: "linear" }}
        />

        {/* accretion disk back */}
        <motion.div
          className="absolute inset-[12%] rounded-full"
          style={{
            background:
              "conic-gradient(from 120deg, transparent, rgba(56,189,248,0.35), rgba(139,92,246,0.55), rgba(34,211,238,0.25), transparent 70%)",
            filter: reduced || off ? "blur(2px)" : "blur(6px)",
            opacity: 0.55 + snap.portalIntensity * 0.35,
          }}
          animate={off ? undefined : { rotate: -360 }}
          transition={off ? undefined : { duration: spin, repeat: Infinity, ease: "linear" }}
        />

        {/* disk front strip */}
        <motion.div
          className="absolute left-[8%] right-[8%] top-1/2 h-[18%] -translate-y-1/2 rounded-[100%]"
          style={{
            background:
              "linear-gradient(90deg, transparent, rgba(56,189,248,0.15), rgba(139,92,246,0.65), rgba(34,211,238,0.35), transparent)",
            filter: "blur(1px)",
          }}
          animate={off ? undefined : { rotate: 360 }}
          transition={off ? undefined : { duration: spin * 0.85, repeat: Infinity, ease: "linear" }}
        />

        {/* event horizon */}
        <div
          className="absolute inset-[28%] rounded-full bg-black"
          style={{
            boxShadow: `
              inset 0 0 40px rgba(0,0,0,1),
              0 0 ${24 + snap.portalIntensity * 30}px rgba(15,10,30,0.9),
              0 0 1px rgba(139,92,246,0.5)
            `,
          }}
        />

        {/* lensing ring */}
        <div
          className="absolute inset-[24%] rounded-full border border-white/10"
          style={{
            boxShadow: `0 0 20px rgba(56,189,248,${0.12 * snap.portalIntensity})`,
            transform: snap.unstable ? `translateX(${Math.sin(Date.now() / 200) * 2}px)` : undefined,
          }}
        />

        {/* completion ring */}
        {snap.progress >= 0.999 && snap.mode === "blackhole" && (
          <div className="absolute inset-[2%] rounded-full border border-success/50" />
        )}

        <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
          <p className="max-w-[14rem] text-base font-medium text-text-primary sm:text-lg">{label}</p>
          {sublabel ? <p className="mt-2 max-w-[16rem] text-xs text-text-secondary sm:text-sm">{sublabel}</p> : null}
        </div>
      </motion.div>
    </div>
  );
}
