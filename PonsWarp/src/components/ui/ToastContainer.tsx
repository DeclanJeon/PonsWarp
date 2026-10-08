import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useToastStore, ToastType, Toast } from '../../store/toastStore';
import { CheckCircle, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';

const icons: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle className="text-green-400" size={20} />,
  error: <AlertCircle className="text-red-400" size={20} />,
  info: <Info className="text-cyan-400" size={20} />,
  warning: <AlertTriangle className="text-yellow-400" size={20} />,
};

const borderColors: Record<ToastType, string> = {
  success: 'border-green-500/30',
  error: 'border-red-500/30',
  info: 'border-cyan-500/30',
  warning: 'border-yellow-500/30',
};

const ToastItem: React.FC<{ toast: Toast }> = ({ toast: item }) => {
  const removeToast = useToastStore(state => state.removeToast);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remainingRef = useRef(item.duration ?? 0);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused || !item.duration) return;
    const started = performance.now();
    const timer = window.setTimeout(() => removeToast(item.id), remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (performance.now() - started));
    };
  }, [paused, item.duration, item.id, removeToast]);

  return (
    <motion.div
      initial={{ opacity: 0, x: 50, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 20, scale: 0.9 }}
      layout
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
      className={`pointer-events-auto flex w-full items-start gap-3 rounded-2xl border bg-black/90 px-4 py-3 shadow-2xl backdrop-blur-xl sm:min-w-[280px] sm:max-w-md sm:items-center sm:px-5 sm:py-4 ${borderColors[item.type]}`}
    >
      <span aria-hidden="true" className="shrink-0 pt-3">{icons[item.type]}</span>
      <p className="flex-1 break-words py-3 text-sm font-medium leading-6 text-white">{item.message}</p>
      <button type="button" aria-label="Dismiss notification" onClick={() => removeToast(item.id)}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-300 transition-colors hover:bg-white/10 hover:text-white">
        <X size={18} />
      </button>
    </motion.div>
  );
};

export const ToastContainer: React.FC = () => {
  const toasts = useToastStore(state => state.toasts);

  return (
    <div role="log" aria-label="Notifications" aria-live="polite" aria-relevant="additions" className="app-toast-stack fixed z-[100] flex flex-col gap-2 pointer-events-none sm:gap-3">
      <AnimatePresence>
        {toasts.map(item => <ToastItem key={item.id} toast={item} />)}
      </AnimatePresence>
    </div>
  );
};
