import React, { useEffect, useRef, useState } from 'react';
import {
  Building2,
  FileText,
  LifeBuoy,
  ReceiptText,
  Scale,
  ShieldCheck,
  X,
} from 'lucide-react';

interface LegalBeaconProps {
  onNavigate: (path: string) => void;
}

const LINKS = [
  {
    path: '/commerce-disclosure',
    label: '사업자 정보',
    icon: Building2,
  },
  {
    path: '/terms',
    label: '이용약관',
    icon: Scale,
  },
  {
    path: '/privacy',
    label: '개인정보처리방침',
    icon: ShieldCheck,
  },
  {
    path: '/refund',
    label: '환불/결제 정책',
    icon: ReceiptText,
  },
  {
    path: '/contact',
    label: '문의/신고',
    icon: LifeBuoy,
  },
];

const LegalBeacon: React.FC<LegalBeaconProps> = ({ onNavigate }) => {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open]);

  const navigate = (path: string) => {
    setOpen(false);
    onNavigate(path);
  };

  return (
    <div
      ref={panelRef}
      className="fixed right-3 bottom-[max(5.25rem,calc(env(safe-area-inset-bottom)+4.5rem))] z-[60] md:right-8 md:bottom-8"
    >
      {open && (
        <div className="mb-3 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-cyan-400/25 bg-gray-950/90 backdrop-blur-xl shadow-[0_0_30px_rgba(6,182,212,0.16)] overflow-hidden">
          <div className="flex items-start justify-between gap-3 border-b border-white/10 px-4 py-3">
            <div>
              <p className="text-xs font-bold tracking-[0.2em] text-cyan-200">
                신뢰 및 정책
              </p>
              <p className="mt-1 text-xs text-gray-400">
                사업자 정보, 개인정보, 환불 기준을 확인할 수 있습니다.
              </p>
            </div>
            <button
              type="button"
              aria-label="정책 패널 닫기"
              onClick={() => setOpen(false)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-gray-300 hover:bg-white/10"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-2">
            {LINKS.map(link => {
              const Icon = link.icon;
              return (
                <button
                  key={link.path}
                  type="button"
                  onClick={() => navigate(link.path)}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-bold text-gray-100 transition-colors hover:bg-white/10 focus:bg-white/10 focus:outline-none"
                >
                  <Icon className="h-4 w-4 text-cyan-300" />
                  <span>{link.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <button
        type="button"
        aria-label="정책 및 사업자 정보 열기"
        onClick={() => setOpen(value => !value)}
        className="flex h-12 min-w-12 items-center justify-center gap-2 rounded-full border border-cyan-400/35 bg-black/60 px-4 text-cyan-100 shadow-[0_0_24px_rgba(6,182,212,0.18)] backdrop-blur-xl transition-colors hover:bg-cyan-500/15"
      >
        <FileText className="h-5 w-5" />
        <span className="hidden text-xs font-bold tracking-[0.18em] md:inline">
          POLICY
        </span>
      </button>
    </div>
  );
};

export default LegalBeacon;
