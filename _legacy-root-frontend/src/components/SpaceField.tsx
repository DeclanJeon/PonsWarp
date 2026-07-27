import { useEffect, useRef } from 'react';
import { useTransferStore } from '../store/transferStore';
import { AppMode } from '../types/types';

const STAR_COUNT = 520;
const IDLE_SPEED = 0.08;
const WARP_SPEED = 2.8;
const ACCELERATION = 0.035;
const MAX_DPR = 1.5;

type Star = {
  x: number;
  y: number;
  z: number;
  size: number;
};

function createStar(): Star {
  const radius = 0.08 + Math.random() * 0.92;
  const angle = Math.random() * Math.PI * 2;

  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
    z: Math.random(),
    size: 0.55 + Math.random() * 1.35,
  };
}

export default function SpaceField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const status = useTransferStore(state => state.status);
  const mode = useTransferStore(state => state.mode);
  const statusRef = useRef(status);
  const modeRef = useRef(mode);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: false });
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

    const draw = (now: number) => {
      const delta = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      const activeStatus = statusRef.current;
      const isWarping =
        activeStatus === 'TRANSFERRING' ||
        activeStatus === 'CONNECTING' ||
        activeStatus === 'RECEIVING';
      const direction = modeRef.current === AppMode.RECEIVER ? -1 : 1;
      const targetSpeed = isWarping
        ? WARP_SPEED * direction
        : activeStatus === 'DRAGGING_FILES'
          ? 0.5
          : IDLE_SPEED;

      currentSpeed += (targetSpeed - currentSpeed) * ACCELERATION * 60 * delta;

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);

      const centerX = width / 2;
      const centerY = height / 2;
      const focalLength = Math.min(width, height) * 0.62;
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

        const alpha = Math.min(1, (1 - depth) * 1.25 + 0.12);
        const length = 1 + absSpeed * 18 * (1 - depth);
        const dx = ((sx - centerX) / Math.max(width, 1)) * length;
        const dy = ((sy - centerY) / Math.max(height, 1)) * length;

        ctx.strokeStyle = `rgba(125, 235, 255, ${alpha})`;
        ctx.lineWidth = star.size * (1.2 - depth);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + dx, sy + dy);
        ctx.stroke();
      }

      const gradient = ctx.createRadialGradient(
        centerX,
        centerY,
        0,
        centerX,
        centerY,
        Math.max(width, height) * 0.72
      );
      gradient.addColorStop(0, 'rgba(6, 182, 212, 0.08)');
      gradient.addColorStop(0.45, 'rgba(168, 85, 247, 0.045)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      animationFrame = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);
    animationFrame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full bg-black -z-50 pointer-events-none"
      aria-hidden="true"
    />
  );
}
