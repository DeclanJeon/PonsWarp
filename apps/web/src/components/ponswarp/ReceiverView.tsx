"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle, Scan } from "lucide-react";
import { useTransferSession } from "@/hooks/useTransferSession";
import { useTransferStore } from "@/stores/transfer-store";
import { formatBytes } from "@/lib/formatting/bytes";
import { getTransferFeedbackLabel } from "@/lib/formatting/eta";
import { sanitizeCodeInput } from "@/lib/formatting/code";
import { TransferProgressBar } from "@/components/ponswarp/TransferProgressBar";
import { toast } from "@/stores/toast-store";

type Props = {
  initialCode?: string;
  onClose?: () => void;
};

export function ReceiverView({ initialCode = "", onClose }: Props) {
  const router = useRouter();
  const { joinSession, accept } = useTransferSession("receiver");
  const viewState = useTransferStore((s) => s.viewState);
  const files = useTransferStore((s) => s.files);
  const progress = useTransferStore((s) => s.progress);
  const errorMessage = useTransferStore((s) => s.errorMessage);
  const receivedBlobs = useTransferStore((s) => s.receivedBlobs);
  const code = useTransferStore((s) => s.code);

  const [receiveInput, setReceiveInput] = useState(initialCode);
  const joinedRef = useRef(false);
  const acceptedRef = useRef(false);

  const roomCode = sanitizeCodeInput(receiveInput);
  const canSubmit = roomCode.length === 6;

  useEffect(() => {
    if (!initialCode || initialCode.length !== 6 || joinedRef.current) return;
    joinedRef.current = true;
    void joinSession(initialCode).catch((err: Error) => toast.error(err.message || "Join failed"));
  }, [initialCode, joinSession]);

  // Auto-start receive as soon as file list arrives — no extra consent screens.
  useEffect(() => {
    if (acceptedRef.current) return;
    if (!files.length) return;
    if (viewState !== "receiver-joined" && viewState !== "ready" && viewState !== "negotiating") return;
    acceptedRef.current = true;
    void accept("blob").catch((err: Error) => toast.error(err.message || "Accept failed"));
  }, [files.length, viewState, accept]);

  useEffect(() => {
    if (errorMessage && (viewState === "failed" || viewState === "expired")) toast.error(errorMessage);
  }, [errorMessage, viewState]);

  useEffect(() => {
    if (viewState === "expired") router.replace("/expired");
  }, [viewState, router]);

  const handleJoin = () => {
    if (!canSubmit) return;
    joinedRef.current = true;
    router.push(`/receive/${roomCode}`);
  };

  const glass =
    "bg-black/40 p-3 backdrop-blur-2xl border border-white/10 rounded-[2rem] shadow-2xl w-full max-w-md mx-4 overflow-hidden relative";

  const isDone = viewState === "completed";
  const isFailed = viewState === "failed" || viewState === "expired";
  const isIdle = !initialCode && !joinedRef.current && viewState === "idle" && !isDone && !isFailed;
  const isProgress =
    !isDone &&
    !isFailed &&
    (["ready", "transferring", "verifying", "paused", "reconnecting", "receiver-joined", "negotiating"].includes(viewState) ||
      Boolean(initialCode || joinedRef.current));

  const totalBytes = files.reduce((s, f) => s + f.size, 0) || progress.totalBytes;

  return (
    <div className="relative z-10 flex w-full flex-col items-center justify-center px-2">
      <AnimatePresence mode="wait">
        {isIdle ? (
          <motion.div
            key="code"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className={glass}
          >
            <div className="p-6 text-center md:p-8">
              <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-3xl border border-white/10 bg-gradient-to-br from-cyan-500/20 to-purple-500/20">
                <Scan className="h-8 w-8 text-white" />
              </div>
              <h2 className="brand-font mb-5 text-2xl font-bold tracking-widest">
                ENTER <span className="text-cyan-400">CODE</span>
              </h2>
              <input
                value={receiveInput}
                onChange={(e) => setReceiveInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleJoin();
                }}
                placeholder="ABC123"
                maxLength={12}
                className="mb-5 w-full rounded-2xl border border-gray-600 bg-black/30 p-5 text-center font-mono text-2xl uppercase tracking-[0.35em] text-white outline-none focus:border-cyan-500 sm:text-3xl"
              />
              <button
                type="button"
                disabled={!canSubmit}
                onClick={handleJoin}
                className="w-full rounded-xl bg-white py-4 text-base font-bold tracking-[0.18em] text-black hover:bg-cyan-300 disabled:opacity-40"
              >
                RECEIVE
              </button>
            </div>
          </motion.div>
        ) : null}

        {isProgress ? (
          <motion.div key="recv" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-xl space-y-6">
            <div className="text-center">
              <h2 className="brand-font mb-2 bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-3xl font-bold text-transparent">
                {viewState === "transferring" || viewState === "verifying" || progress.transferredBytes > 0
                  ? "RECEIVING..."
                  : files.length > 0
                    ? "STARTING..."
                    : "WAITING FOR SENDER..."}
              </h2>
              <p className="font-mono text-xs tracking-widest text-gray-500">{code || roomCode || initialCode}</p>
              <p className="mt-3 font-mono text-6xl font-black text-white">
                {(progress.progress * 100).toFixed(1)}
                <span className="text-2xl text-gray-500">%</span>
              </p>
              <p className="mt-2 font-mono text-sm text-purple-100/70">
                {files.length
                  ? getTransferFeedbackLabel(progress.transferredBytes, progress.totalBytes || totalBytes, progress.currentSpeedBps)
                  : "Keep the sender tab open. Transfer starts automatically."}
              </p>
            </div>
            <TransferProgressBar />
            {files.length > 0 ? (
              <p className="text-center font-mono text-xs text-gray-400">
                {files.length} files · {formatBytes(progress.transferredBytes)} / {formatBytes(totalBytes)}
              </p>
            ) : (
              <p className="text-center text-xs text-gray-500">
                If this stays empty, the sender is offline or the code expired.
              </p>
            )}
          </motion.div>
        ) : null}

        {isDone ? (
          <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={`${glass} p-8 text-center`}>
            <CheckCircle className="mx-auto mb-4 h-14 w-14 text-emerald-400" />
            <h2 className="brand-font text-2xl font-bold tracking-widest">RECEIVED</h2>
            <p className="mt-2 text-sm text-gray-400">Files are ready.</p>
            {receivedBlobs.length > 0 ? (
              <ul className="mt-5 space-y-2 text-left">
                {receivedBlobs.map((f) => (
                  <li key={f.id}>
                    <a href={f.url} download={f.name} className="block truncate rounded-xl border border-white/10 px-3 py-2 text-sm text-cyan-300 hover:bg-white/5">
                      {f.name}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            <button
              type="button"
              onClick={() => {
                onClose?.();
                router.push("/");
              }}
              className="mt-6 rounded-full border border-white/10 px-5 py-2.5 text-xs uppercase tracking-[0.18em] text-gray-300 hover:bg-white/10"
            >
              Done
            </button>
          </motion.div>
        ) : null}

        {isFailed ? (
          <motion.div key="fail" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={`${glass} p-8 text-center`} role="alert">
            <AlertCircle className="mx-auto mb-4 h-12 w-12 text-red-400" />
            <h2 className="brand-font text-2xl font-bold tracking-widest text-red-300">FAILED</h2>
            <p className="mt-2 text-sm text-gray-400">{errorMessage || "Could not receive files."}</p>
            <button
              type="button"
              onClick={() => {
                onClose?.();
                router.push("/receive");
              }}
              className="mt-6 rounded-full border border-white/10 px-5 py-2.5 text-xs uppercase tracking-[0.18em] text-gray-300 hover:bg-white/10"
            >
              Try again
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {!isDone && !isFailed && !isIdle ? (
        <button
          type="button"
          onClick={() => {
            onClose?.();
            router.push("/");
          }}
          className="fixed bottom-5 rounded-full border border-white/10 bg-black/35 px-5 py-2.5 text-xs uppercase tracking-[0.18em] text-gray-300 backdrop-blur-md hover:bg-white/10 md:bottom-8"
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}
