import { debugLog } from './utils/logger';
import { registerAppUpdateServiceWorker } from './utils/appUpdateService';
import { useTransferStore } from './store/transferStore';

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
import {
  usePreventNavigation,
  isTransferSessionActive,
  leaveTransferSessionIfConfirmed,
} from './hooks/usePreventNavigation';

const SpaceField = lazy(() => import('./components/SpaceField'));

const App: React.FC = () => {
  // 전역 스토어 사용 (SpaceField와 동기화)
  const { mode, setMode, setRoomId, status } = useTransferStore();
  const [cloudShareId, setCloudShareId] = useState<string | null>(null);
  usePreventNavigation();

  // URL 파라미터 체크 (앱 로드 시)
    useEffect(() => {
    void registerAppUpdateServiceWorker({
      isTransferActive: () => {
        const status = useTransferStore.getState().status;
        return (
          status === 'TRANSFERRING' ||
          status === 'RECEIVING' ||
          status === 'SCANNING' ||
          status === 'PREPARING' ||
          status === 'WAITING' ||
          status === 'CONNECTING' ||
          status === 'UPLOADING' ||
          status === 'REMOTE_PROCESSING' ||
          status === 'QUEUED'
        );
      },
    });
  }, []);

useEffect(() => {
    const syncRoute = () => {
      const path = window.location.pathname;
      const receiveMatch = path.match(/^\/receive\/([A-Z0-9]{6})$/i);
      const cloudMatch = path.match(/^\/cloud\/([A-Za-z0-9-]{8,80})$/);
      const current = useTransferStore.getState();

      if (cloudMatch) {
        setCloudShareId(cloudMatch[1]);
        setMode(AppMode.CLOUD_RECEIVER);
        return;
      }
      if (receiveMatch) {
        const roomId = normalizeRoomCodeInput(receiveMatch[1]);
        setRoomId(roomId);
        setMode(AppMode.RECEIVER);
        return;
      }

      // Never kick an active transfer session back to INTRO on bare "/".
      // Mobile back-gesture / logo history can otherwise unmount the transfer UI.
      if (isTransferSessionActive(current.mode, current.status)) {
        return;
      }

      // Only reset when already on a non-transfer route surface.
      if (
        current.mode === AppMode.SENDER ||
        current.mode === AppMode.RECEIVER ||
        current.mode === AppMode.CLOUD_SENDER ||
        current.mode === AppMode.CLOUD_RECEIVER ||
        current.mode === AppMode.SELECTION
      ) {
        return;
      }

      setCloudShareId(null);
      setMode(AppMode.INTRO);
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
        - 모바일: p-4, h-screen overflow-hidden
        - 데스크탑: p-8, 레이아웃 중앙 정렬
      */}
      <div className="app-shell relative text-white bg-transparent font-rajdhani select-none">
        {/* 1. 배경 계층 (3D Space) */}
        <Suspense
          fallback={
            <div className="fixed inset-0 w-full h-full bg-black -z-50 pointer-events-none" />
          }
        >
          <SpaceField />
        </Suspense>

        {/* 2. 오버레이 계층 (Toast, Status, Flash) */}
        <StatusOverlay />
        <ToastContainer />
        {status === 'DONE' && (
          <motion.div
            className="fixed inset-0 bg-cyan-400 pointer-events-none z-40 mix-blend-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.6, 0] }}
            transition={{ duration: 1.0, ease: 'circOut' }}
          />
        )}

        {/* 3. Header (Responsive) */}
        <header
          className="app-header absolute top-0 left-0 z-50 flex w-full items-center justify-between px-4 py-3 sm:px-6 sm:py-4 md:px-10 md:py-6 cursor-pointer"
          onClick={() => {
            leaveTransferSessionIfConfirmed(() => {
              setCloudShareId(null);
              setMode(AppMode.INTRO);
              window.history.pushState({}, '', '/');
            });
          }}
        >
          <div className="flex items-center gap-2 md:gap-4 hover:opacity-80 transition-opacity">
            <div className="w-8 h-8 md:w-10 md:h-10 border-2 border-cyan-500 rounded-full flex items-center justify-center backdrop-blur-sm bg-black/20 shadow-[0_0_15px_rgba(6,182,212,0.5)]">
              <div className="w-2 h-2 md:w-3 md:h-3 bg-white rounded-full shadow-[0_0_10px_rgba(255,255,255,1)] animate-pulse" />
            </div>
            <h1 className="text-lg sm:text-xl md:text-3xl font-bold tracking-widest brand-font drop-shadow-lg">
              PONS<span className="text-cyan-500">WARP</span>
            </h1>
          </div>
          {/* Security Badge (Visual Assurance) */}
          <div
            className="flex min-w-0 items-center gap-2 md:gap-3"
            onClick={event => event.stopPropagation()}
          >
            <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-mono text-gray-300 backdrop-blur-md sm:flex">
              <ShieldCheck size={15} className="text-emerald-400" />
              <span>End-to-End Encrypted</span>
            </div>
          </div>
        </header>

        {/* 4. Main Content Area */}
        <main className="app-main relative z-10 flex h-full w-full flex-col items-center overflow-y-auto">
          <AnimatePresence mode="wait">
            {/* --- INTRO SCREEN --- */}
            {mode === AppMode.INTRO && (
              <motion.div
                key="intro"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20, filter: 'blur(10px)' }}
                className="my-auto flex w-full max-w-5xl flex-col items-center justify-center space-y-6 py-8 text-center sm:space-y-10 sm:py-16 md:space-y-12 md:py-20"
              >
                <div className="space-y-5 md:space-y-7">
                  {/* 캐치프레이즈 리뉴얼 */}
                  <div className="flex items-center justify-center">
                    <span className="flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-cyan-200 backdrop-blur-md">
                      <Zap size={13} fill="currentColor" /> Next-Gen P2P
                    </span>
                  </div>
                  <h2 className="brand-font text-[clamp(2.1rem,9vw,5.75rem)] font-black leading-[0.98] tracking-[-0.04em] drop-shadow-[0_0_40px_rgba(6,182,212,0.4)]">
                    HYPER-SPEED
                    <br />
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-purple-500 animate-gradient-x">
                      ZERO LIMITS.
                    </span>
                  </h2>
                  <p className="mx-auto max-w-2xl px-4 text-base leading-7 text-gray-300 sm:text-lg md:text-xl md:leading-8">
                    <span className="block">
                      Transfer files directly from browser to browser.
                    </span>
                    <span className="mt-1 block">
                      No size caps, no detours—just a secure, high-speed link.
                    </span>
                  </p>
                </div>

                <div className="flex items-center justify-center">
                  <MagneticButton
                    onClick={startApp}
                    className="relative group bg-white text-black border border-white/50 px-9 py-4 md:px-12 md:py-5 rounded-full font-bold text-base md:text-lg tracking-[0.16em] hover:bg-cyan-500 hover:text-white hover:border-cyan-400 transition-all shadow-[0_0_30px_rgba(255,255,255,0.3)] overflow-hidden"
                  >
                    <span className="relative z-10 flex items-center gap-3">
                      INITIALIZE LINK
                      <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                    </span>
                  </MagneticButton>
                </div>
              </motion.div>
            )}

            {/* --- SELECTION SCREEN --- */}
            {mode === AppMode.SELECTION && (
              <motion.section
                key="selection"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.05, filter: 'blur(10px)' }}
                aria-labelledby="transfer-mode-heading"
                className="my-auto w-full max-w-5xl px-0 pb-2 pt-2 sm:px-2 sm:pt-4 md:px-4 md:py-0"
              >
                <div className="mb-5 text-center md:mb-7">
                  <p className="mb-2 text-xs font-bold uppercase tracking-[0.24em] text-cyan-300">
                    Secure transfer
                  </p>
                  <h2
                    id="transfer-mode-heading"
                    className="brand-font text-2xl font-bold tracking-wide text-white sm:text-3xl md:text-4xl"
                  >
                    Choose how to connect
                  </h2>
                  <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-gray-400 sm:text-base">
                    Start a live transfer, create a shareable link, or receive
                    files from someone else.
                  </p>
                </div>

                <div className="grid w-full grid-cols-1 items-stretch gap-4 md:grid-cols-2 md:gap-5">
                  <div className="group relative flex flex-col overflow-hidden rounded-[1.5rem] border border-white/10 bg-black/45 p-4 shadow-2xl backdrop-blur-xl transition-colors duration-300 hover:border-cyan-400/50 sm:rounded-[1.75rem] sm:p-6 md:min-h-[350px]">
                    <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/10 via-transparent to-emerald-500/10 opacity-60" />

                    <div className="relative z-10 flex items-center gap-4">
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-400/10 shadow-lg sm:h-16 sm:w-16">
                        <Send className="h-7 w-7 text-cyan-100 sm:h-8 sm:w-8" />
                      </div>
                      <div>
                        <h3 className="brand-font text-2xl font-bold tracking-wider text-white sm:text-3xl">
                          SEND
                        </h3>
                        <p className="mt-1 text-sm text-gray-400">
                          Pick the delivery style that fits.
                        </p>
                      </div>
                    </div>

                    <div className="relative z-10 mt-5 grid flex-1 gap-3">
                      <button
                        onClick={() => setMode(AppMode.SENDER)}
                        className="group/p2p flex min-h-[88px] flex-col justify-center rounded-2xl border border-cyan-400/30 bg-cyan-500/10 px-4 py-3.5 text-left transition-all hover:border-cyan-300 hover:bg-cyan-500/20 sm:min-h-[98px] sm:px-5 sm:py-4"
                      >
                        <span className="flex items-center gap-2 text-base font-bold tracking-[0.12em] text-cyan-100 sm:text-lg">
                          <Zap className="h-5 w-5" />
                          SEND NOW
                        </span>
                        <span className="mt-2 text-sm leading-5 text-cyan-50/75 sm:text-base sm:leading-6">
                          Transfer live while both people keep this page open.
                        </span>
                      </button>

                      <button
                        onClick={() => setMode(AppMode.CLOUD_SENDER)}
                        className="group/cloud flex min-h-[88px] flex-col justify-center rounded-2xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3.5 text-left transition-all hover:border-emerald-300 hover:bg-emerald-500/20 sm:min-h-[98px] sm:px-5 sm:py-4"
                      >
                        <span className="flex items-center gap-2 text-base font-bold tracking-[0.12em] text-emerald-100 sm:text-lg">
                          <CloudUpload className="h-5 w-5" />
                          SEND BY LINK
                        </span>
                        <span className="mt-2 text-sm leading-5 text-emerald-50/75 sm:text-base sm:leading-6">
                          Upload once and share a free link for files up to
                          10GB.
                        </span>
                      </button>
                    </div>
                  </div>

                  <MagneticButton
                    onClick={() => setMode(AppMode.RECEIVER)}
                    className="group relative flex min-h-[150px] w-full flex-col items-center justify-center overflow-hidden rounded-[1.5rem] border border-white/10 bg-black/45 p-5 shadow-2xl backdrop-blur-xl transition-colors duration-300 hover:border-purple-400/50 sm:min-h-[180px] sm:rounded-[1.75rem] sm:p-6 md:min-h-[350px]"
                  >
                    <div className="absolute inset-0 bg-gradient-to-br from-purple-500/10 via-transparent to-cyan-500/5 opacity-60" />
                    <div className="relative z-10 flex flex-col items-center text-center">
                      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-purple-300/20 bg-purple-400/10 shadow-lg sm:h-16 sm:w-16">
                        <Download className="h-7 w-7 text-purple-100 sm:h-8 sm:w-8" />
                      </div>
                      <p className="mt-5 text-xs font-bold uppercase tracking-[0.22em] text-purple-300">
                        Code or link
                      </p>
                      <h3 className="brand-font mt-2 text-2xl font-bold tracking-wider text-white sm:text-3xl">
                        RECEIVE
                      </h3>
                      <p className="mt-2 max-w-xs text-sm leading-6 text-gray-400 sm:text-base">
                        Enter a room code or open a shared download link.
                      </p>
                    </div>
                  </MagneticButton>
                </div>
              </motion.section>
            )}

            {/* --- ACTIVE STATES (SENDER/RECEIVER VIEWS) --- */}
            {(mode === AppMode.SENDER || status === 'TRANSFERRING') && (
              <motion.div
                key="sender"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex min-h-full w-full flex-col items-center justify-start pb-4 pt-2 sm:pt-4 md:justify-center md:pb-6 md:pt-6"
              >
                <SenderView />

                {status === 'TRANSFERRING' && (
                  <div className="mt-8 w-full max-w-xl px-4">
                    <TransferProgressBar />
                  </div>
                )}

                <button
                  onClick={() => {
                    leaveTransferSessionIfConfirmed(() => {
                      setMode(AppMode.SELECTION);
                    });
                  }}
                  className="app-bottom-action rounded-full border border-white/10 bg-black/55 px-5 py-2.5 text-[11px] uppercase tracking-[0.16em] text-gray-200 shadow-lg backdrop-blur-md transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white sm:text-xs sm:tracking-[0.18em]"
                >
                  Abort Mission
                </button>
              </motion.div>
            )}

            {mode === AppMode.CLOUD_SENDER && (
              <motion.div
                key="cloud-sender"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex min-h-full w-full flex-col items-center justify-start pb-4 pt-2 sm:pt-4 md:justify-center md:pb-6 md:pt-6"
              >
                <CloudSenderView />

                <button
                  onClick={() => {
                    leaveTransferSessionIfConfirmed(() => {
                      setMode(AppMode.SELECTION);
                    });
                  }}
                  className="app-bottom-action rounded-full border border-white/10 bg-black/55 px-5 py-2.5 text-[11px] uppercase tracking-[0.16em] text-gray-200 shadow-lg backdrop-blur-md transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white sm:text-xs sm:tracking-[0.18em]"
                >
                  Close Drop
                </button>
              </motion.div>
            )}

            {mode === AppMode.CLOUD_RECEIVER && cloudShareId && (
              <motion.div
                key="cloud-receiver"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex h-full w-full flex-col items-center justify-center pb-4 pt-2 md:pb-6 md:pt-6"
              >
                <CloudDownloadView shareId={cloudShareId} />

                <button
                  onClick={() => {
                    leaveTransferSessionIfConfirmed(() => {
                      setCloudShareId(null);
                      setMode(AppMode.SELECTION);
                      window.history.pushState({}, '', '/');
                    });
                  }}
                  className="app-bottom-action rounded-full border border-white/10 bg-black/55 px-5 py-2.5 text-[11px] uppercase tracking-[0.16em] text-gray-200 shadow-lg backdrop-blur-md transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white sm:text-xs sm:tracking-[0.18em]"
                >
                  Close Drop
                </button>
              </motion.div>
            )}

            {mode === AppMode.RECEIVER && (
              <motion.div
                key="receiver"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex min-h-full w-full flex-col items-center justify-start pb-4 pt-2 sm:pt-4 md:justify-center md:pb-6 md:pt-6"
              >
                <ReceiverView
                  onOpenCloudShare={shareId => {
                    setCloudShareId(shareId);
                    setMode(AppMode.CLOUD_RECEIVER);
                    window.history.pushState({}, '', `/cloud/${shareId}`);
                  }}
                />

                <button
                  onClick={() => {
                    leaveTransferSessionIfConfirmed(() => {
                      setMode(AppMode.SELECTION);
                      setRoomId(null);
                    });
                  }}
                  className="app-bottom-action rounded-full border border-white/10 bg-black/55 px-5 py-2.5 text-[11px] uppercase tracking-[0.16em] text-gray-200 shadow-lg backdrop-blur-md transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white sm:text-xs sm:tracking-[0.18em]"
                >
                  Close Gate
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
