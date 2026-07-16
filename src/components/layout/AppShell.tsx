"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { SpaceField } from "@/components/ponswarp/SpaceField";
import { StatusOverlay } from "@/components/ponswarp/StatusOverlay";
import { ToastContainer } from "@/components/ponswarp/ToastContainer";
import { useTransferStore } from "@/stores/transfer-store";
import type { MotionIntensity } from "@/lib/types";

type Props = { children: React.ReactNode };

export function AppShell({ children }: Props) {
  const intensity = useTransferStore((s) => s.motionIntensity);
  const setIntensity = useTransferStore((s) => s.setMotionIntensity);

  return (
    <div className="relative flex min-h-dvh flex-1 flex-col overflow-hidden bg-black font-sans text-white antialiased">
      <SpaceField />
      <div className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(0,0,0,0.35)_55%,rgba(0,0,0,0.78)_100%)]" />
      <StatusOverlay />
      <ToastContainer />

      <header className="absolute inset-x-0 top-0 z-50">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5 md:px-8 md:py-6">
          <Link href="/" className="group flex items-center gap-3 transition-opacity hover:opacity-90">
            <div className="relative flex h-9 w-9 items-center justify-center rounded-full border border-cyan-400/60 bg-black/30 shadow-[0_0_18px_rgba(6,182,212,0.35)] backdrop-blur-md md:h-10 md:w-10">
              <div className="h-2.5 w-2.5 animate-pulse rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.9)]" />
              <div className="absolute inset-0 rounded-full border border-cyan-300/20 group-hover:scale-110 transition-transform" />
            </div>
            <h1 className="brand-font text-lg font-bold tracking-[0.22em] md:text-2xl">
              PONS<span className="text-cyan-400">WARP</span>
            </h1>
          </Link>

          <div className="flex items-center gap-2 md:gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-2 font-mono text-xs text-gray-300 backdrop-blur-md sm:flex">
              <ShieldCheck size={14} className="text-emerald-400" />
              <span>E2E Encrypted</span>
            </div>
            <label className="flex items-center gap-2 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs text-gray-400 backdrop-blur-md">
              <span className="hidden sm:inline">Motion</span>
              <select
                className="bg-transparent text-cyan-200 outline-none"
                value={intensity}
                onChange={(e) => setIntensity(e.target.value as MotionIntensity)}
                aria-label="Motion intensity"
              >
                <option value="full">Full</option>
                <option value="reduced">Reduced</option>
                <option value="off">Off</option>
              </select>
            </label>
          </div>
        </div>
      </header>

      <main className="relative z-10 flex min-h-dvh w-full flex-col">
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 pb-8 pt-24 md:px-8 md:pt-28">
          {children}
        </div>
      </main>
    </div>
  );
}
