import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useToastStore, ToastType } from '../../store/toastStore';
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

export const ToastContainer: React.FC = () => {
  const { toasts, removeToast } = useToastStore();

  return (
    <div className="app-toast-stack fixed z-[100] flex flex-col gap-2 pointer-events-none sm:gap-3">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 20, scale: 0.9 }}
            layout
            className={`pointer-events-auto flex w-full items-start gap-3 rounded-2xl border bg-black/70 px-4 py-3 shadow-2xl backdrop-blur-xl sm:min-w-[280px] sm:max-w-md sm:items-center sm:px-5 sm:py-4 ${borderColors[t.type]}`}
          >
            {icons[t.type]}
            <p className="flex-1 text-sm font-medium leading-snug text-white/90 break-words">
              {t.message}
            </p>
            <button
              onClick={() => removeToast(t.id)}
              className="text-white/40 hover:text-white transition-colors"
            >
              <X size={16} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
