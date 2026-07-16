"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Download, FilePlus, Folder, Send, Upload, Zap } from "lucide-react";
import { MagneticButton } from "@/components/ponswarp/MagneticButton";
import { FadeUp, MotionLine } from "@/components/ponswarp/TextMotion";

type Screen = "intro" | "selection" | "send-drop";

export default function HomePage() {
  const router = useRouter();
  const reduce = useReducedMotion();
  const [screen, setScreen] = useState<Screen>("intro");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const goSend = (list: File[]) => {
    if (!list.length) return;
    (window as Window & { __warpspaceFiles?: File[] }).__warpspaceFiles = list;
    router.push("/send");
  };

  return (
    <div className="page-center w-full flex-1">
      <AnimatePresence mode="wait">
        {screen === "intro" ? (
          <motion.section
            key="intro"
            initial={reduce ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -14, filter: "blur(8px)" }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="mx-auto flex w-full max-w-5xl flex-col items-center justify-center text-center"
          >
            <FadeUp delay={0.05}>
              <span className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-100 backdrop-blur-md">
                <Zap size={12} fill="currentColor" />
                Browser P2P Transfer
              </span>
            </FadeUp>

            <h2 className="brand-font mt-7 text-[clamp(2.8rem,8.4vw,5.8rem)] font-black leading-[0.95] tracking-[-0.04em]">
              <span className="block drop-shadow-[0_0_40px_rgba(6,182,212,0.28)]">
                <MotionLine text="HYPER-SPEED" delay={0.12} />
              </span>
              <span className="mt-2 block">
                <MotionLine text="ZERO LIMITS." delay={0.28} gradient />
              </span>
            </h2>

            <FadeUp delay={0.55} className="mx-auto mt-6 max-w-2xl px-2">
              <p className="text-base leading-7 text-gray-300 sm:text-lg sm:leading-8">
                Transfer files directly from browser to browser.
                <span className="mt-1 block text-gray-400">No size caps. No central storage. Just a secure link.</span>
              </p>
            </FadeUp>

            <FadeUp delay={0.72} className="mt-10">
              <MagneticButton
                onClick={() => setScreen("selection")}
                className="rounded-full border border-white/50 bg-white px-9 py-4 text-base font-bold tracking-[0.16em] text-black shadow-[0_0_30px_rgba(255,255,255,0.22)] transition-colors hover:border-cyan-300 hover:bg-cyan-400 hover:text-black md:px-12 md:py-5 md:text-lg"
              >
                INITIALIZE LINK
                <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
              </MagneticButton>
            </FadeUp>

            <FadeUp delay={0.9} className="mt-8 flex flex-wrap items-center justify-center gap-2 text-[11px] uppercase tracking-[0.18em] text-gray-500">
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Direct P2P</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Streaming I/O</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">QR Share</span>
            </FadeUp>
          </motion.section>
        ) : null}

        {screen === "selection" ? (
          <motion.section
            key="selection"
            initial={reduce ? false : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, scale: 0.98, filter: "blur(8px)" }}
            transition={{ duration: 0.4 }}
            className="mx-auto flex w-full max-w-5xl flex-col justify-center"
          >
            <div className="mb-7 text-center md:mb-9">
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.24em] text-cyan-300">Secure transfer</p>
              <h2 className="brand-font text-2xl font-bold tracking-wide text-white sm:text-3xl md:text-4xl">
                Choose how to connect
              </h2>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-gray-400 sm:text-base">
                Start a live transfer or receive files from someone else.
              </p>
            </div>

            <div className="grid w-full grid-cols-1 items-stretch gap-4 md:grid-cols-2 md:gap-5">
              <motion.div
                initial={reduce ? false : { opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="group relative flex min-h-[320px] flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-black/45 p-5 shadow-2xl backdrop-blur-xl transition-colors duration-300 hover:border-cyan-400/50 sm:p-6 md:min-h-[360px]"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/10 via-transparent to-emerald-500/10 opacity-60" />
                <div className="relative z-10 flex items-center gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-400/10 shadow-lg sm:h-16 sm:w-16">
                    <Send className="h-7 w-7 text-cyan-100 sm:h-8 sm:w-8" />
                  </div>
                  <div className="text-left">
                    <h3 className="brand-font text-2xl font-bold tracking-wider text-white sm:text-3xl">SEND</h3>
                    <p className="mt-1 text-sm text-gray-400">Pick files and open a warp room.</p>
                  </div>
                </div>
                <div className="relative z-10 mt-5 grid flex-1 content-end gap-3">
                  <button
                    type="button"
                    onClick={() => setScreen("send-drop")}
                    className="flex min-h-[104px] flex-col justify-center rounded-2xl border border-cyan-400/30 bg-cyan-500/10 px-5 py-4 text-left transition-all hover:border-cyan-300 hover:bg-cyan-500/20"
                  >
                    <span className="flex items-center gap-2 text-base font-bold tracking-[0.12em] text-cyan-100 sm:text-lg">
                      <Zap className="h-5 w-5" />
                      SEND NOW
                    </span>
                    <span className="mt-2 text-sm leading-5 text-cyan-50/75 sm:text-base">
                      Drop files, get a code, keep both tabs open.
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push("/send")}
                    className="flex min-h-[72px] flex-col justify-center rounded-2xl border border-white/10 bg-white/5 px-5 py-4 text-left transition-all hover:border-cyan-400/30 hover:bg-white/10"
                  >
                    <span className="text-sm font-bold tracking-[0.12em] text-gray-200">OPEN SEND ROOM</span>
                    <span className="mt-1 text-xs text-gray-500">Go straight to the drop zone</span>
                  </button>
                </div>
              </motion.div>

              <motion.div
                initial={reduce ? false : { opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12 }}
                className="h-full"
              >
                <MagneticButton
                  onClick={() => router.push("/receive")}
                  className="group relative flex h-full min-h-[320px] w-full flex-col items-center justify-center overflow-hidden rounded-[1.75rem] border border-white/10 bg-black/45 p-6 shadow-2xl backdrop-blur-xl transition-colors duration-300 hover:border-purple-400/50 md:min-h-[360px]"
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-purple-500/10 via-transparent to-cyan-500/5 opacity-60" />
                  <div className="relative z-10 flex flex-col items-center text-center">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-purple-300/20 bg-purple-400/10 shadow-lg sm:h-16 sm:w-16">
                      <Download className="h-7 w-7 text-purple-100 sm:h-8 sm:w-8" />
                    </div>
                    <p className="mt-5 text-xs font-bold uppercase tracking-[0.22em] text-purple-300">Code or link</p>
                    <h3 className="brand-font mt-2 text-2xl font-bold tracking-wider text-white sm:text-3xl">RECEIVE</h3>
                    <p className="mt-2 max-w-xs text-sm leading-6 text-gray-400 sm:text-base">
                      Enter a room code to join a live transfer.
                    </p>
                  </div>
                </MagneticButton>
              </motion.div>
            </div>

            <div className="mt-6 flex justify-center">
              <button
                type="button"
                onClick={() => setScreen("intro")}
                className="rounded-full border border-white/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-gray-400 hover:bg-white/5"
              >
                Back
              </button>
            </div>
          </motion.section>
        ) : null}

        {screen === "send-drop" ? (
          <motion.div
            key="send-drop"
            initial={reduce ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -10 }}
            className="mx-auto flex w-full max-w-2xl flex-col justify-center"
          >
            <div className="mb-5 text-center">
              <p className="text-xs font-bold uppercase tracking-[0.22em] text-cyan-300">Sender</p>
              <h2 className="brand-font mt-2 text-2xl font-bold text-white">Drop files to open a room</h2>
            </div>
            <div
              className="glass-panel border-cyan-500/20 p-2"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                goSend(Array.from(e.dataTransfer.files || []));
              }}
            >
              <div className="flex flex-col items-center justify-center rounded-[1.6rem] border-2 border-dashed border-cyan-500/30 px-4 py-12 text-center transition hover:border-cyan-400/60 hover:bg-cyan-500/5">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  multiple
                  onChange={(e) => {
                    goSend(Array.from(e.target.files || []));
                    e.target.value = "";
                  }}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  className="hidden"
                  multiple
                  // @ts-expect-error webkitdirectory non-standard
                  webkitdirectory=""
                  onChange={(e) => {
                    goSend(Array.from(e.target.files || []));
                    e.target.value = "";
                  }}
                />
                <Upload className="mb-5 h-10 w-10 animate-pulse text-cyan-400" />
                <h3 className="brand-font text-2xl font-bold text-white">DROP FILES</h3>
                <p className="mt-2 text-sm text-cyan-100/60">or select from device</p>
                <div className="mt-6 flex w-full max-w-sm flex-col gap-3 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-gray-600 bg-gray-800/80 px-4 py-3 text-white hover:border-cyan-500"
                  >
                    <FilePlus className="h-4 w-4 text-cyan-400" />
                    <span className="text-sm font-bold tracking-wider">FILES</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-gray-600 bg-gray-800/80 px-4 py-3 text-white hover:border-yellow-500"
                  >
                    <Folder className="h-4 w-4 text-yellow-400" />
                    <span className="text-sm font-bold tracking-wider">FOLDER</span>
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-center">
              <button
                type="button"
                onClick={() => setScreen("selection")}
                className="rounded-full border border-white/10 px-4 py-2 text-xs uppercase tracking-[0.18em] text-gray-400 hover:bg-white/5"
              >
                Back
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
