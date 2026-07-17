import React from 'react';
import { Loader2, WifiOff } from 'lucide-react';
import { useTransferStore } from '../../store/transferStore';

export const StatusOverlay: React.FC = () => {
  const status = useTransferStore(state => state.status);

  if (status !== 'CONNECTING') return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm transition-all duration-500">
      <div className="w-full max-w-sm rounded-3xl border border-yellow-500/30 bg-black/80 p-6 text-center shadow-[0_0_50px_rgba(234,179,8,0.2)] sm:p-8">
        <div className="relative w-16 h-16 mx-auto mb-6">
          <WifiOff
            className="absolute inset-0 m-auto text-yellow-500/50"
            size={32}
          />
          <Loader2 className="w-full h-full text-yellow-500 animate-spin" />
        </div>
        <h3 className="mb-2 text-xl font-bold tracking-widest text-white sm:text-2xl">
          ESTABLISHING LINK
        </h3>
        <p className="text-yellow-400/80 font-mono animate-pulse">
          Connecting to peer...
        </p>
      </div>
    </div>
  );
};
