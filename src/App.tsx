import { debugLog } from './utils/logger';

import React, { Suspense, lazy, useEffect, useState } from 'react';
import {
  Send,
  Download,
  ArrowRight,
  ShieldCheck,
  Zap,
  CloudUpload,
} from 'lucide-react';
import SenderView from './components/SenderView';
import ReceiverView from './components/ReceiverView';
import CloudSenderView from './components/CloudSenderView';
import CloudDownloadView from './components/CloudDownloadView';
import { AppMode } from './types/types';
import { motion, AnimatePresence } from 'framer-motion';
import { signalingFactory } from './services/signaling-factory';
import { MagneticButton } from './components/ui/MagneticButton';
import { TransferProgressBar } from './components/ui/TransferProgressBar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastContainer } from './components/ui/ToastContainer';
import { StatusOverlay } from './components/ui/StatusOverlay';
import { useTransferStore } from './store/transferStore';
import { toast } from './store/toastStore';
import { normalizeRoomCodeInput } from './utils/roomCode';

const SpaceField = lazy(() => import('./components/SpaceField'));

const App: React.FC = () => {
  // 전역 스토어 사용 (SpaceField와 동기화)
  const { mode, setMode, setRoomId, status } = useTransferStore();
  const [cloudShareId, setCloudShareId] = useState<string | null>(null);

  // URL 파라미터 체크 (앱 로드 시)
  useEffect(() => {
    const syncRoute = () => {
      const path = window.location.pathname;
      const receiveMatch = path.match(/^\/receive\/([A-Z0-9]{6})$/i);
      const cloudMatch = path.match(/^\/cloud\/([A-Za-z0-9-]{8,80})$/);

      if (cloudMatch) {
        setCloudShareId(cloudMatch[1]);
        setMode(AppMode.CLOUD_RECEIVER);
      } else if (receiveMatch) {
        const roomId = normalizeRoomCodeInput(receiveMatch[1]);
        setRoomId(roomId);
        setMode(AppMode.RECEIVER);
      } else {
        setCloudShareId(null);
        setMode(AppMode.INTRO);
      }
    };

    syncRoute();
    window.addEventListener('popstate', syncRoute);

    // 글로벌 에러 핸들러
    const handleRejection = (event: PromiseRejectionEvent) => {
      toast.error(`Unexpected Error: ${event.reason?.message || 'Unknown'}`);
    };
    window.addEventListener('unhandledrejection', handleRejection);

    return () => {
      window.removeEventListener('popstate', syncRoute);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, [setRoomId, setMode]);

  const startApp = () => setMode(AppMode.SELECTION);

  // Signaling 연결 관리
  useEffect(() => {
    const initSignaling = async () => {
      try {
        debugLog(
          '[App] Connecting to signaling server:',
          signalingFactory.getServerUrl()
        );
        await signalingFactory.connect();
        debugLog(
          '[App] Signaling connected, using Rust:',
          signalingFactory.isUsingRust()
        );
      } catch (error) {
        toast.error('Failed to connect to signaling server');
        console.error('[App] Signaling connection failed:', error);
      }
    };

    initSignaling();
  }, []);

  return (
    <ErrorBoundary>
      {/* [반응형 레이아웃 전략]
        - 모바일: p-4, min-h-dvh로 주소창 변화 대응
        - 데스크탑: p-8, 레이아웃 중앙 정렬
      */}
      <div className="relative min-h-dvh w-full overflow-hidden text-white bg-transparent select-none">
        {/* 1. 배경 계층 (3D Space) */}
        <Suspense
          fallback={
            <div className="fixed inset-0 w-full h-full bg-[#071016] -z-50 pointer-events-none" />
          }
        >
          <SpaceField />
        </Suspense>

        {/* 2. 오버레이 계층 (Toast, Status, Flash) */}
        <StatusOverlay />
        <ToastContainer />
        {status === 'DONE' && (
          <motion.div
            className="fixed inset-0 bg-cyan-300 pointer-events-none z-40 mix-blend-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.6, 0] }}
            transition={{ duration: 1.0, ease: 'circOut' }}
          />
        )}

        {/* 3. Header (Responsive) */}
        <header
          className="absolute top-0 left-0 w-full p-4 md:p-8 z-50 flex items-center justify-between cursor-pointer"
          onClick={() => {
            setCloudShareId(null);
            setMode(AppMode.INTRO);
            window.history.pushState({}, '', '/');
          }}
        >
          <div className="flex items-center gap-2 md:gap-4 hover:opacity-85 transition-opacity">
            <div className="w-8 h-8 md:w-10 md:h-10 border border-cyan-300/70 rounded-2xl flex items-center justify-center backdrop-blur-sm bg-slate-950/30 shadow-[0_18px_45px_rgba(20,105,125,0.24)]">
              <div className="w-2 h-2 md:w-3 md:h-3 bg-white rounded-full shadow-[0_0_10px_rgba(255,255,255,1)] animate-pulse" />
            </div>
            <h1 className="text-xl md:text-3xl font-extrabold tracking-tight brand-font drop-shadow-lg">
              Pons<span className="text-cyan-200">Warp</span>
            </h1>
          </div>
          {/* Security Badge (Visual Assurance) */}
          <div
            className="flex min-w-0 items-center gap-2 md:gap-3"
            onClick={event => event.stopPropagation()}
          >
            <div className="hidden items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-slate-300 sm:flex">
              <ShieldCheck size={14} className="text-cyan-200" />
              <span>Encrypted direct transfer</span>
            </div>
          </div>
        </header>

        {/* 4. Main Content Area */}
        <main className="relative z-10 w-full h-full flex flex-col items-center justify-center p-4">
          <AnimatePresence mode="wait">
            {/* --- INTRO SCREEN --- */}
            {mode === AppMode.INTRO && (
              <motion.div
                key="intro"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20, filter: 'blur(10px)' }}
                className="flex flex-col items-center justify-center max-w-4xl w-full text-center space-y-8 md:space-y-12"
              >
                <div className="space-y-4 md:space-y-6">
                  {/* 캐치프레이즈 리뉴얼 */}
                  <div className="flex justify-center items-center gap-2 mb-2">
                    <span className="px-3 py-1 bg-cyan-300/10 border border-cyan-200/20 rounded-xl text-xs font-semibold text-cyan-100 tracking-[0.16em] uppercase flex items-center gap-1">
                      <Zap size={12} fill="currentColor" /> Direct browser transfer
                    </span>
                  </div>
                  <h2 className="text-4xl md:text-7xl font-black brand-font tracking-[-0.06em] drop-shadow-[0_28px_80px_rgba(28,126,145,0.28)] leading-[0.95]">
                    Move large files
                    <br />
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-cyan-100 to-cyan-300 animate-gradient-x">
                      without a server
                    </span>
                  </h2>
                  <p className="text-slate-300 text-sm md:text-xl max-w-[60ch] mx-auto leading-relaxed px-6">
                    Send directly between browsers, or create a temporary Cloud
                    Drop link when both people cannot stay online.
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row items-center gap-3">
                  <MagneticButton
                    onClick={startApp}
                    className="relative group bg-white text-slate-950 border border-white/60 px-8 py-3 md:px-12 md:py-5 rounded-2xl font-semibold text-base md:text-lg tracking-wide hover:bg-cyan-100 hover:border-cyan-200 transition-all duration-200 shadow-[0_24px_70px_rgba(18,104,124,0.28)] overflow-hidden active:translate-y-px"
                  >
                    <span className="relative z-10 flex items-center gap-3">
                      Start transfer
                      <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                    </span>
                  </MagneticButton>
                </div>
              </motion.div>
            )}

            {/* --- SELECTION SCREEN (Grid Layout) --- */}
            {mode === AppMode.SELECTION && (
              <motion.div
                key="selection"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.05, filter: 'blur(10px)' }}
                className="w-full max-w-6xl px-4"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 w-full items-stretch justify-center">
                  <div className="group relative flex min-h-[360px] md:min-h-[380px] flex-col justify-between bg-slate-950/55 backdrop-blur-xl border border-white/10 rounded-[2rem] hover:border-cyan-200/50 transition-all duration-300 shadow-[0_28px_90px_rgba(2,12,18,0.42)] w-full overflow-hidden p-6 md:p-8">
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(56,184,200,0.16),transparent_24rem)] opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

                    <div className="relative z-10 flex items-center gap-4">
                      <div className="relative shrink-0">
                        <div className="absolute inset-0 bg-cyan-300 blur-2xl opacity-15 group-hover:opacity-35 transition-opacity" />
                        <div className="w-16 h-16 md:w-20 md:h-20 rounded-2xl bg-slate-900/85 border border-white/10 group-hover:border-cyan-200/60 flex items-center justify-center relative z-10 shadow-lg">
                          <Send className="w-8 h-8 md:w-10 md:h-10 text-cyan-50" />
                        </div>
                      </div>

                      <div>
                        <h3 className="text-3xl md:text-5xl font-extrabold brand-font tracking-tight group-hover:text-cyan-100 transition-colors">
                          Send
                        </h3>
                        <p className="text-slate-400 text-xs md:text-sm tracking-[0.16em] uppercase">
                          Choose a sending method
                        </p>
                      </div>
                    </div>

                    <div className="relative z-10 grid gap-3 md:gap-4">
                      <button
                        onClick={() => setMode(AppMode.SENDER)}
                        className="group/p2p flex min-h-[104px] flex-col justify-center rounded-2xl border border-cyan-200/25 bg-cyan-300/10 px-5 py-4 text-left transition duration-200 hover:-translate-y-0.5 hover:bg-cyan-300/15 hover:border-cyan-100/50 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                      >
                        <span className="flex items-center gap-2 text-lg md:text-xl font-semibold tracking-wide text-cyan-50">
                          <Zap className="w-5 h-5" />
                          Send directly
                        </span>
                        <span className="mt-2 text-sm md:text-base text-cyan-50/75 leading-snug">
                          Stream from this browser while both people stay on the page.
                        </span>
                      </button>

                      <button
                        onClick={() => setMode(AppMode.CLOUD_SENDER)}
                        className="group/cloud flex min-h-[104px] flex-col justify-center rounded-2xl border border-slate-500/30 bg-white/[0.06] px-5 py-4 text-left transition duration-200 hover:-translate-y-0.5 hover:bg-white/[0.09] hover:border-cyan-100/35 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                      >
                        <span className="flex items-center gap-2 text-lg md:text-xl font-semibold tracking-wide text-slate-100">
                          <CloudUpload className="w-5 h-5 text-cyan-100" />
                          Send by link
                        </span>
                        <span className="mt-2 text-sm md:text-base text-slate-300 leading-snug">
                          Upload once and share a temporary pickup link, free up to 10GB.
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* RECEIVER CARD - 높이 축소 */}
                  <MagneticButton
                    onClick={() => setMode(AppMode.RECEIVER)}
                    className="group relative flex flex-col items-center justify-center min-h-[240px] md:min-h-[380px] bg-slate-950/55 backdrop-blur-xl border border-white/10 rounded-[2rem] hover:border-cyan-200/45 transition-all duration-300 shadow-[0_28px_90px_rgba(2,12,18,0.42)] w-full overflow-hidden"
                  >
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_60%_35%,rgba(56,184,200,0.12),transparent_24rem)] opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

                    <div className="relative mb-4 md:mb-6 transform group-hover:scale-110 transition-transform duration-300">
                      <div className="absolute inset-0 bg-cyan-300 blur-2xl opacity-15 group-hover:opacity-35 transition-opacity" />
                      <div className="w-16 h-16 md:w-20 md:h-20 rounded-2xl bg-slate-900/85 border border-white/10 group-hover:border-cyan-200/60 flex items-center justify-center relative z-10 shadow-lg">
                        <Download className="w-8 h-8 md:w-10 md:h-10 text-cyan-50" />
                      </div>
                    </div>

                    <div className="relative z-10 text-center space-y-1">
                      <h3 className="text-2xl md:text-4xl font-extrabold brand-font tracking-tight group-hover:text-cyan-100 transition-colors">
                        Receive
                      </h3>
                      <p className="text-slate-400 text-xs md:text-sm tracking-[0.16em] uppercase">
                        Enter a code or open a download link
                      </p>
                    </div>
                  </MagneticButton>
                </div>
              </motion.div>
            )}

            {/* --- ACTIVE STATES (SENDER/RECEIVER VIEWS) --- */}
            {(mode === AppMode.SENDER || status === 'TRANSFERRING') && (
              <motion.div
                key="sender"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="w-full h-full flex flex-col items-center justify-center pt-20 pb-10"
              >
                <SenderView />

                {status === 'TRANSFERRING' && (
                  <div className="mt-8 w-full max-w-xl px-4">
                    <TransferProgressBar />
                  </div>
                )}

                <button
                  onClick={() => setMode(AppMode.SELECTION)}
                  className="fixed bottom-8 text-slate-400 hover:text-white transition-colors uppercase tracking-widest text-xs py-2 px-4 hover:bg-white/5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200"
                >
                  Cancel transfer
                </button>
              </motion.div>
            )}

            {mode === AppMode.CLOUD_SENDER && (
              <motion.div
                key="cloud-sender"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="w-full h-full flex flex-col items-center justify-center pt-20 pb-10"
              >
                <CloudSenderView />

                <button
                  onClick={() => setMode(AppMode.SELECTION)}
                  className="fixed bottom-8 text-slate-400 hover:text-white transition-colors uppercase tracking-widest text-xs py-2 px-4 hover:bg-white/5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200"
                >
                  Back
                </button>
              </motion.div>
            )}

            {mode === AppMode.CLOUD_RECEIVER && cloudShareId && (
              <motion.div
                key="cloud-receiver"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="w-full h-full flex flex-col items-center justify-center pt-20 pb-10"
              >
                <CloudDownloadView shareId={cloudShareId} />

                <button
                  onClick={() => {
                    setCloudShareId(null);
                    setMode(AppMode.SELECTION);
                    window.history.pushState({}, '', '/');
                  }}
                  className="fixed bottom-8 text-slate-400 hover:text-white transition-colors uppercase tracking-widest text-xs py-2 px-4 hover:bg-white/5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200"
                >
                  Back
                </button>
              </motion.div>
            )}

            {mode === AppMode.RECEIVER && (
              <motion.div
                key="receiver"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="w-full h-full flex flex-col items-center justify-center pt-20 pb-10"
              >
                <ReceiverView />

                <button
                  onClick={() => {
                    setMode(AppMode.SELECTION);
                    setRoomId(null);
                  }}
                  className="fixed bottom-8 text-slate-400 hover:text-white transition-colors uppercase tracking-widest text-xs py-2 px-4 hover:bg-white/5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200"
                >
                  Back
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </ErrorBoundary>
  );
};

export default App;
