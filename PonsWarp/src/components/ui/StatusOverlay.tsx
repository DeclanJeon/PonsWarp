import React from 'react';
import { Loader2 } from 'lucide-react';
import { useTransferStore } from '../../store/transferStore';

export const StatusOverlay: React.FC = () => {
  const status = useTransferStore(state => state.status);

  if (status !== 'CONNECTING') return null;

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-4 top-20 z-40 flex justify-center">
      <div className="flex items-center gap-3 rounded-xl border border-yellow-500/30 bg-black/90 px-4 py-3 text-sm text-yellow-100 shadow-lg">
        <Loader2 className="h-5 w-5 animate-spin" />
        Connecting to the other device — keep this page open
      </div>
    </div>
  );
};
