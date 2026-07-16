"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CheckCircle,
  File as FileIcon,
  FilePlus,
  Folder,
  Upload,
} from "lucide-react";
import { useTransferSession } from "@/hooks/useTransferSession";
import { useTransferStore } from "@/stores/transfer-store";
import { formatBytes } from "@/lib/formatting/bytes";
import { getTransferFeedbackLabel } from "@/lib/formatting/eta";
import { TransferProgressBar } from "@/components/ponswarp/TransferProgressBar";
import { toast } from "@/stores/toast-store";

type Props = { onAbort?: () => void };

export function SenderView({ onAbort }: Props) {
  const { setFiles, createSession, startTransfer, endSession } = useTransferSession("sender");
  const viewState = useTransferStore((s) => s.viewState);
  const files = useTransferStore((s) => s.files);
  const code = useTransferStore((s) => s.code);
  const shareUrl = useTransferStore((s) => s.shareUrl);
  const progress = useTransferStore((s) => s.progress);
  const errorMessage = useTransferStore((s) => s.errorMessage);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const creatingRef = useRef(false);
  const startedRef = useRef(false);
  const [copied, setCopied] = useState(false);

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const rootName = files.length === 1 ? files[0]?.name : `${files.length} files`;

  useEffect(() => {
    // Prefer active room; only seed staged files when no room yet.
    if (code) return;
    const staged = (window as Window & { __warpspaceFiles?: File[] }).__warpspaceFiles;
    if (staged?.length) void setFiles(staged);
  }, [setFiles, code]);

  useEffect(() => {
    if (!files.length) return;
    if (code) return;
    if (viewState !== "files-selected" && viewState !== "idle") return;
    if (creatingRef.current) return;
    creatingRef.current = true;
    void createSession().catch((err: Error) => {
      creatingRef.current = false;
      toast.error(err.message || "Failed to open room");
    });
  }, [files.length, viewState, createSession, code]);

  useEffect(() => {
    if (viewState === "ready" && !startedRef.current) {
      startedRef.current = true;
      void startTransfer().catch((err: Error) => toast.error(err.message || "Failed to start transfer"));
    }
  }, [viewState, startTransfer]);

  useEffect(() => {
    if (errorMessage && viewState === "failed") toast.error(errorMessage);
  }, [errorMessage, viewState]);

  const applyFiles = (list: File[]) => {
    if (!list.length) return;
    (window as Window & { __warpspaceFiles?: File[] }).__warpspaceFiles = list;
    creatingRef.current = false;
    startedRef.current = false;
    void setFiles(list);
  };

  const copyLink = async () => {
    if (!shareUrl && !code) return;
    try {
      await navigator.clipboard.writeText(shareUrl || code || "");
      setCopied(true);
      toast.success("Copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const glass = "bg-black/40 backdrop-blur-2xl border border-cyan-500/20 rounded-[2rem] shadow-[0_0_40px_rgba(0,0,0,0.3)]";

  // Only 3 practical screens: drop | share(code/QR) | transfer(+done/fail)
  const showDrop = !code && files.length === 0 && viewState !== "completed" && viewState !== "failed";
  const showShare =
    Boolean(code) &&
    !["ready", "transferring", "verifying", "paused", "reconnecting", "completed", "failed", "expired"].includes(viewState);
  const showProgress = ["ready", "transferring", "verifying", "paused", "reconnecting"].includes(viewState);
  const showDone = viewState === "completed";
  const showFail = viewState === "failed" || viewState === "expired";

  return (
    <div className="relative z-10 flex w-full flex-col items-center justify-center px-2 pb-10 pt-2">
      <AnimatePresence mode="wait">
        {showDrop ? (
          <motion.div
            key="drop"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className={`w-full max-w-2xl p-2 ${glass}`}
          >
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                applyFiles(Array.from(e.dataTransfer.files || []));
              }}
              className="flex flex-col items-center rounded-[1.6rem] border-2 border-dashed border-cyan-500/30 px-4 py-12 text-center hover:border-cyan-400/60 hover:bg-cyan-500/5"
            >
              <input ref={fileInputRef} type="file" className="hidden" multiple onChange={(e) => { applyFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />
              <input
                ref={folderInputRef}
                type="file"
                className="hidden"
                multiple
                // @ts-expect-error webkitdirectory
                webkitdirectory=""
                onChange={(e) => { applyFiles(Array.from(e.target.files || [])); e.target.value = ""; }}
              />
              <Upload className="mb-5 h-10 w-10 animate-pulse text-cyan-400" />
              <h2 className="brand-font text-2xl font-bold">DROP FILES</h2>
              <p className="mt-2 text-sm text-cyan-100/60">select files or folder</p>
              <div className="mt-6 flex w-full max-w-sm flex-col gap-3 sm:flex-row">
                <button type="button" onClick={() => fileInputRef.current?.click()} className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-gray-600 bg-gray-800/80 py-3 text-white hover:border-cyan-500">
                  <FilePlus className="h-4 w-4 text-cyan-400" />
                  <span className="text-sm font-bold tracking-wider">FILES</span>
                </button>
                <button type="button" onClick={() => folderInputRef.current?.click()} className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-gray-600 bg-gray-800/80 py-3 text-white hover:border-yellow-500">
                  <Folder className="h-4 w-4 text-yellow-400" />
                  <span className="text-sm font-bold tracking-wider">FOLDER</span>
                </button>
              </div>
            </div>
          </motion.div>
        ) : null}

        {showShare && code && shareUrl ? (
          <motion.div
            key="share"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className={`flex w-full max-w-sm flex-col items-center p-6 md:p-8 ${glass}`}
          >
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-4 py-1.5">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
              </span>
              <span className="text-xs font-bold tracking-[0.2em] text-cyan-300">SHARE THIS CODE</span>
            </div>

            <button type="button" onClick={() => void copyLink()} className="mb-5 rounded-2xl bg-white p-3 shadow-[0_0_40px_rgba(6,182,212,0.25)]">
              <QRCodeSVG value={shareUrl} size={180} className="h-[140px] w-[140px] md:h-[180px] md:w-[180px]" bgColor="#ffffff" fgColor="#0b1020" />
            </button>

            <button type="button" onClick={() => void copyLink()} className="group w-full text-center">
              <p className="mb-2 text-[10px] uppercase tracking-[0.3em] text-gray-500">Warp Key</p>
              <div className="relative">
                <p className="bg-300% animate-shine bg-gradient-to-r from-cyan-400 via-white to-cyan-400 bg-clip-text font-mono text-4xl font-bold tracking-widest text-transparent md:text-5xl">
                  {code}
                </p>
                {copied ? (
                  <span className="absolute -right-7 top-1/2 -translate-y-1/2 text-green-400">
                    <Check size={20} />
                  </span>
                ) : null}
              </div>
            </button>

            <div className="mt-5 flex w-full items-center gap-3 rounded-xl border border-gray-700/50 bg-gray-800/30 p-3 text-left">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-700/50">
                {files.length > 1 ? <Folder className="h-5 w-5 text-yellow-400" /> : <FileIcon className="h-5 w-5 text-blue-400" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-white">{rootName}</p>
                <p className="font-mono text-xs text-gray-400">
                  {files.length} files · {formatBytes(totalBytes)}
                </p>
              </div>
            </div>

            <p className="mt-4 font-mono text-xs text-gray-500">
              {viewState === "receiver-joined" || viewState === "negotiating"
                ? "Receiver connected · waiting to start..."
                : "Waiting for receiver..."}
            </p>
          </motion.div>
        ) : null}

        {showShare && !code ? (
          <motion.div key="opening" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={`w-full max-w-sm p-8 text-center ${glass}`}>
            <p className="font-mono text-sm tracking-widest text-cyan-300">OPENING ROOM...</p>
          </motion.div>
        ) : null}

        {showProgress ? (
          <motion.div key="progress" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-xl space-y-6">
            <div className="text-center">
              <h2 className="brand-font mb-2 bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-3xl font-bold text-transparent">
                SENDING...
              </h2>
              <p className="font-mono text-6xl font-black text-white">
                {(progress.progress * 100).toFixed(1)}
                <span className="text-2xl text-gray-500">%</span>
              </p>
              <p className="mt-2 font-mono text-sm text-cyan-100/70">
                {getTransferFeedbackLabel(progress.transferredBytes, progress.totalBytes, progress.currentSpeedBps)}
              </p>
            </div>
            <TransferProgressBar />
            <p className="text-center font-mono text-xs text-gray-400">
              {formatBytes(progress.transferredBytes)} / {formatBytes(progress.totalBytes || totalBytes)}
            </p>
          </motion.div>
        ) : null}

        {showDone ? (
          <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={`w-full max-w-md p-8 text-center ${glass}`}>
            <CheckCircle className="mx-auto mb-4 h-14 w-14 text-emerald-400" />
            <h2 className="brand-font text-2xl font-bold tracking-widest">SENT</h2>
            <p className="mt-2 text-sm text-gray-400">Receiver has the files.</p>
            <button
              type="button"
              onClick={() => {
                endSession();
                onAbort?.();
              }}
              className="mt-6 rounded-full border border-white/10 px-5 py-2.5 text-xs uppercase tracking-[0.18em] text-gray-300 hover:bg-white/10"
            >
              New transfer
            </button>
          </motion.div>
        ) : null}

        {showFail ? (
          <motion.div key="fail" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={`w-full max-w-md p-8 text-center ${glass}`} role="alert">
            <h2 className="brand-font text-2xl font-bold tracking-widest text-red-300">FAILED</h2>
            <p className="mt-2 text-sm text-gray-400">{errorMessage || "Transfer failed."}</p>
            <button
              type="button"
              onClick={() => {
                endSession();
                onAbort?.();
              }}
              className="mt-6 rounded-full border border-white/10 px-5 py-2.5 text-xs uppercase tracking-[0.18em] text-gray-300 hover:bg-white/10"
            >
              Back
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {!showDone && !showFail ? (
        <button
          type="button"
          onClick={() => {
            endSession();
            onAbort?.();
          }}
          className="fixed bottom-5 rounded-full border border-white/10 bg-black/35 px-5 py-2.5 text-xs uppercase tracking-[0.18em] text-gray-300 backdrop-blur-md hover:bg-white/10 md:bottom-8"
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}
