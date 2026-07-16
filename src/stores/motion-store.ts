"use client";

import { getWarpMotionParams, lerp } from "@/lib/motion/motion-map";
import type { MotionIntensity, Role, TransferViewState, WarpMotionParams } from "@/lib/types";

type MotionSnapshot = WarpMotionParams & {
  progress: number;
  speedBps: number;
  bufferedRatio: number;
  intensity: MotionIntensity;
};

type Listener = () => void;

let snapshot: MotionSnapshot = {
  mode: "idle",
  portalIntensity: 0.25,
  particleSpeed: 0.1,
  particleDensity: 0.15,
  unstable: false,
  progress: 0,
  speedBps: 0,
  bufferedRatio: 0,
  intensity: "full",
};

let target = { ...snapshot };
const listeners = new Set<Listener>();
let raf = 0;

function emit() {
  for (const l of listeners) l();
}

function tick() {
  raf = 0;
  const next: MotionSnapshot = {
    ...target,
    portalIntensity: lerp(snapshot.portalIntensity, target.portalIntensity, 0.08),
    particleSpeed: lerp(snapshot.particleSpeed, target.particleSpeed, 0.1),
    particleDensity: lerp(snapshot.particleDensity, target.particleDensity, 0.08),
    progress: lerp(snapshot.progress, target.progress, 0.12),
    speedBps: lerp(snapshot.speedBps, target.speedBps, 0.15),
    bufferedRatio: lerp(snapshot.bufferedRatio, target.bufferedRatio, 0.1),
    unstable: target.unstable,
    mode: target.mode,
    intensity: target.intensity,
  };
  snapshot = next;
  emit();

  const drifting =
    Math.abs(snapshot.portalIntensity - target.portalIntensity) > 0.002 ||
    Math.abs(snapshot.particleSpeed - target.particleSpeed) > 0.002 ||
    Math.abs(snapshot.progress - target.progress) > 0.001;
  if (drifting) raf = requestAnimationFrame(tick);
}

export function updateMotionFromTransfer(opts: {
  viewState: TransferViewState;
  role: Role | null;
  progress: number;
  speedBps: number;
  bufferedAmount: number;
  intensity: MotionIntensity;
}): void {
  const role = opts.role ?? "sender";
  const bufferedRatio = Math.min(1, opts.bufferedAmount / (2 * 1024 * 1024));
  const params = getWarpMotionParams(opts.viewState, role, opts.speedBps, bufferedRatio);
  target = {
    ...params,
    progress: opts.progress,
    speedBps: opts.speedBps,
    bufferedRatio,
    intensity: opts.intensity,
  };
  if (!raf) raf = requestAnimationFrame(tick);
}

export function getMotionSnapshot(): MotionSnapshot {
  return snapshot;
}

export function subscribeMotion(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
