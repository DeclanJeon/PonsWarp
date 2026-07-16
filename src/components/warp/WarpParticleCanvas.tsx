"use client";

import { useEffect, useRef } from "react";
import { getMotionSnapshot, subscribeMotion } from "@/stores/motion-store";
import { useDevicePerformance } from "@/hooks/useDevicePerformance";
import type { MotionIntensity } from "@/lib/types";

type Particle = {
  angle: number;
  radius: number;
  speed: number;
  size: number;
  alpha: number;
  life: number;
  inbound: boolean;
};

type Props = {
  className?: string;
  intensity?: MotionIntensity;
};

export function WarpParticleCanvas({ className, intensity = "full" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const perf = useDevicePerformance();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let particles: Particle[] = [];
    let raf = 0;
    let running = true;
    let w = 0;
    let h = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, perf.dprCap);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const budgetFor = () => {
      const snap = getMotionSnapshot();
      const effective = intensity === "off" || snap.intensity === "off" ? 0 : intensity === "reduced" || snap.intensity === "reduced" ? 0.2 : 1;
      return Math.floor(perf.particleBudget * snap.particleDensity * effective);
    };

    const spawn = (inbound: boolean) => {
      const snap = getMotionSnapshot();
      particles.push({
        angle: Math.random() * Math.PI * 2,
        radius: inbound ? 0.35 + Math.random() * 0.55 : Math.random() * 0.08,
        speed: (0.002 + Math.random() * 0.01) * (0.4 + snap.particleSpeed),
        size: 0.6 + Math.random() * 1.8,
        alpha: 0.25 + Math.random() * 0.55,
        life: 1,
        inbound,
      });
    };

    const ensureCount = () => {
      const budget = budgetFor();
      while (particles.length < budget) {
        const snap = getMotionSnapshot();
        spawn(snap.mode !== "whitehole");
      }
      if (particles.length > budget) particles.length = budget;
    };

    const draw = () => {
      if (!running) return;
      if (document.visibilityState === "hidden") {
        raf = requestAnimationFrame(draw);
        return;
      }

      const snap = getMotionSnapshot();
      ensureCount();
      ctx.clearRect(0, 0, w, h);

      if (intensity === "off" || snap.intensity === "off") {
        raf = requestAnimationFrame(draw);
        return;
      }

      const cx = w / 2;
      const cy = h / 2;
      const baseR = Math.min(w, h) * 0.28;
      const inbound = snap.mode !== "whitehole";

      for (const p of particles) {
        if (inbound) {
          p.radius -= p.speed * (0.6 + snap.particleSpeed);
          p.angle += p.speed * 2.2;
          if (p.radius < 0.04) {
            p.radius = 0.35 + Math.random() * 0.55;
            p.angle = Math.random() * Math.PI * 2;
          }
        } else {
          p.radius += p.speed * (0.7 + snap.particleSpeed);
          p.angle += p.speed * 1.4;
          if (p.radius > 0.95) {
            p.radius = Math.random() * 0.08;
            p.angle = Math.random() * Math.PI * 2;
          }
        }

        const r = baseR * p.radius;
        const x = cx + Math.cos(p.angle) * r * (1 + (snap.unstable ? Math.sin(performance.now() / 120) * 0.03 : 0));
        const y = cy + Math.sin(p.angle) * r * 0.72;
        const progressFade = inbound ? 1 - snap.progress * 0.3 : 0.55 + snap.progress * 0.45;

        ctx.beginPath();
        ctx.fillStyle = inbound
          ? `rgba(139, 92, 246, ${p.alpha * progressFade})`
          : `rgba(223, 250, 255, ${p.alpha * progressFade})`;
        ctx.arc(x, y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      // data stream arcs during transfer
      if (snap.particleSpeed > 0.2) {
        ctx.strokeStyle = inbound ? "rgba(56, 189, 248, 0.12)" : "rgba(223, 250, 255, 0.14)";
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i += 1) {
          const t = performance.now() / 1000 + i;
          ctx.beginPath();
          ctx.ellipse(cx, cy, baseR * (0.4 + (t % 1) * 0.5), baseR * 0.28, t * 0.3, 0, Math.PI * 1.4);
          ctx.stroke();
        }
      }

      raf = requestAnimationFrame(draw);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const unsub = subscribeMotion(() => {
      /* snapshot pulled each frame */
    });
    raf = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsub();
    };
  }, [intensity, perf.dprCap, perf.particleBudget]);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
}
