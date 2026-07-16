"use client";

import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from "lucide-react";
import { useToastStore, type ToastType } from "@/stores/toast-store";

const icons: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle className="text-green-400" size={20} />,
  error: <AlertCircle className="text-red-400" size={20} />,
  info: <Info className="text-cyan-400" size={20} />,
  warning: <AlertTriangle className="text-yellow-400" size={20} />,
};

const borderColors: Record<ToastType, string> = {
  success: "border-green-500/30",
  error: "border-red-500/30",
  info: "border-cyan-500/30",
  warning: "border-yellow-500/30",
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  return (
    <div className="pointer-events-none fixed bottom-8 right-8 z-[100] flex flex-col gap-3">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 20, scale: 0.9 }}
            layout
            className={`pointer-events-auto flex min-w-[300px] max-w-md items-center gap-3 rounded-2xl border bg-black/60 px-5 py-4 shadow-2xl backdrop-blur-xl ${borderColors[t.type]}`}
          >
            {icons[t.type]}
            <p className="flex-1 text-sm font-medium text-white/90">{t.message}</p>
            <button type="button" onClick={() => removeToast(t.id)} className="text-white/40 transition-colors hover:text-white">
              <X size={16} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
