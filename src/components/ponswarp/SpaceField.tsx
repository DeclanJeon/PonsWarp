"use client";

import { useEffect, useRef } from "react";
import { useTransferStore } from "@/stores/transfer-store";
import type { TransferViewState } from "@/lib/types";

const STAR_COUNT = 360;
const IDLE_SPEED = 0.06;
const WARP_SPEED = 2.4;
const ACCELERATION = 0.03;
const MAX_DPR = 1.5;

type Star = { x: number; y: number; z: number; size: number; twinkle: number };

function createStar(): Star {
  const radius = 0.08 + Math.random() * 0.92;
  const angle = Math.random() * Math.PI * 2;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
    z: Math.random(),
    size: 0.5 + Math.random() * 1.3,
    twinkle: Math.random() * Math.PI * 2,
  };
}

function isWarping(state: TransferViewState): boolean {
  return (
    state === "transferring" ||
    state === "negotiating" ||
    state === "receiver-joined" ||
    state === "creating-session" ||
    state === "verifying" ||
    state === "ready"
  );
}

export function SpaceField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewState = useTransferStore((s) => s.viewState);
  const role = useTransferStore((s) => s.role);
  const intensity = useTransferStore((s) => s.motionIntensity);
  const statusRef = useRef(viewState);
  const roleRef = useRef(role);
  const intensityRef = useRef(intensity);
  const mouseRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    statusRef.current = viewState;
  }, [viewState]);
  useEffect(() => {
    roleRef.current = role;
  }, [role]);
  useEffect(() => {
    intensityRef.current = intensity;
  }, [intensity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const stars = Array.from({ length: STAR_COUNT }, createStar);
    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let currentSpeed = IDLE_SPEED;
    let lastTime = performance.now();

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const onMove = (e: MouseEvent) => {
      mouseRef.current.x = (e.clientX / Math.max(width, 1) - 0.5) * 2;
      mouseRef.current.y = (e.clientY / Math.max(height, 1) - 0.5) * 2;
    };

    const draw = (now: number) => {
      if (document.visibilityState === "hidden" || intensityRef.current === "off") {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, width, height);
        animationFrame = requestAnimationFrame(draw);
        return;
      }

      const delta = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      const motionScale = intensityRef.current === "reduced" ? 0.35 : 1;
      const direction = roleRef.current === "receiver" ? -1 : 1;
      const targetSpeed = (isWarping(statusRef.current) ? WARP_SPEED * direction : IDLE_SPEED) * motionScale;
      currentSpeed += (targetSpeed - currentSpeed) * ACCELERATION * 60 * delta;

      // deep space base
      ctx.fillStyle = "#02040a";
      ctx.fillRect(0, 0, width, height);

      const centerX = width / 2 + mouseRef.current.x * 18;
      const centerY = height / 2 + mouseRef.current.y * 12;
      const focalLength = Math.min(width, height) * 0.64;
      const absSpeed = Math.abs(currentSpeed);

      for (const star of stars) {
        star.z -= currentSpeed * delta * 0.12;
        if (star.z <= 0.02) star.z += 1;
        if (star.z > 1) star.z -= 1;

        const depth = Math.max(star.z, 0.02);
        const sx = centerX + (star.x * focalLength) / depth;
        const sy = centerY + (star.y * focalLength) / depth;
        if (sx < -80 || sx > width + 80 || sy < -80 || sy > height + 80) {
          Object.assign(star, createStar());
          continue;
        }

        const twinkle = 0.7 + Math.sin(now / 700 + star.twinkle) * 0.3;
        const alpha = Math.min(1, (1 - depth) * 1.2 + 0.1) * twinkle;
        const length = 1 + absSpeed * 16 * (1 - depth);
        const dx = ((sx - centerX) / Math.max(width, 1)) * length;
        const dy = ((sy - centerY) / Math.max(height, 1)) * length;

        ctx.strokeStyle = `rgba(140, 230, 255, ${alpha})`;
        ctx.lineWidth = star.size * (1.15 - depth * 0.5);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + dx, sy + dy);
        ctx.stroke();
      }

      // soft color wash
      const gradient = ctx.createRadialGradient(
        centerX,
        centerY,
        0,
        centerX,
        centerY,
        Math.max(width, height) * 0.7,
      );
      gradient.addColorStop(0, "rgba(6, 182, 212, 0.07)");
      gradient.addColorStop(0.45, "rgba(168, 85, 247, 0.04)");
      gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      animationFrame = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove, { passive: true });
    animationFrame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 -z-50 h-full w-full bg-black"
      aria-hidden
    />
  );
}
