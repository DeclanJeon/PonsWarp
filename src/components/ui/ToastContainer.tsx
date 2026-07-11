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
    <div className="fixed bottom-8 right-8 z-[100] flex flex-col gap-3 pointer-events-none">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 20, scale: 0.9 }}
            layout
            className={`pointer-events-auto flex items-center gap-3 px-5 py-4 bg-black/60 backdrop-blur-xl border ${borderColors[t.type]} rounded-2xl shadow-2xl min-w-[300px] max-w-md`}
          >
            {icons[t.type]}
            <p className="text-sm font-medium text-white/90 flex-1">
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
