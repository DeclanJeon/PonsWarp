/* 🪲 [DEBUG] App.tsx UI/UX 개선 시작 */
console.log('[App.tsx] 🪲 [DEBUG] UI/UX Enhancement Started:');
console.log('[App.tsx] 🪲 [DEBUG] - Applying responsive grid layout');
console.log('[App.tsx] 🪲 [DEBUG] - Implementing fluid typography');
console.log('[App.tsx] 🪲 [DEBUG] - Adding visual hierarchy improvements');

import React, { Suspense, lazy, useEffect, useState } from 'react';
import {
  Send,
  Download,
  ArrowRight,
  ShieldCheck,
  Zap,
  CloudUpload,
  CreditCard,
  LogOut,
  User,
} from 'lucide-react';
import SenderView from './components/SenderView';
import ReceiverView from './components/ReceiverView';
import CloudSenderView from './components/CloudSenderView';
import CloudDownloadView from './components/CloudDownloadView';
import PricingView from './components/PricingView';
import LegalBeacon from './components/LegalBeacon';
import LegalPageView from './components/LegalPageView';
import AdminDashboardView from './components/AdminDashboardView';
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
import {
  AuthState,
  getAuthState,
  logout,
  startGoogleSignIn,
} from './services/authService';

const SpaceField = lazy(() => import('./components/SpaceField'));

const App: React.FC = () => {
  // 전역 스토어 사용 (SpaceField와 동기화)
  const { mode, setMode, setRoomId, status } = useTransferStore();
  const [cloudShareId, setCloudShareId] = useState<string | null>(null);
  const [legalPath, setLegalPath] = useState('/legal');
  const [authState, setAuthState] = useState<AuthState>({
    authenticated: false,
  });
  const [authLoading, setAuthLoading] = useState(true);

  // URL 파라미터 체크 (앱 로드 시)
  useEffect(() => {
    const syncRoute = () => {
      const path = window.location.pathname;
      const receiveMatch = path.match(/^\/receive\/([A-Z0-9]{6})$/);
      const cloudMatch = path.match(/^\/cloud\/([A-Za-z0-9-]{8,80})$/);
      const legalMatch = [
        '/legal',
        '/privacy',
        '/terms',
        '/refund',
        '/commerce-disclosure',
        '/contact',
      ].includes(path);

      if (cloudMatch) {
        setCloudShareId(cloudMatch[1]);
        setMode(AppMode.CLOUD_RECEIVER);
      } else if (path === '/pricing') {
        setCloudShareId(null);
        setMode(AppMode.PRICING);
      } else if (path === '/admin' || path.startsWith('/admin/')) {
        setCloudShareId(null);
        setMode(AppMode.ADMIN);
      } else if (legalMatch) {
        setCloudShareId(null);
        setLegalPath(path);
        setMode(AppMode.LEGAL);
      } else if (receiveMatch) {
        const roomId = receiveMatch[1];
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
  const refreshAuth = async () => {
    setAuthLoading(true);
    try {
      setAuthState(await getAuthState());
    } catch {
      setAuthState({ authenticated: false });
    } finally {
      setAuthLoading(false);
    }
  };
  const signIn = () => startGoogleSignIn(window.location.pathname);
  const signOut = async () => {
    try {
      await logout();
      setAuthState({ authenticated: false });
    } catch (error: any) {
      toast.error(error?.message || 'Failed to sign out');
    }
  };
  const openPricing = () => {
    setCloudShareId(null);
    setMode(AppMode.PRICING);
    window.history.pushState({}, '', '/pricing');
  };
  const openCloudDrop = () => {
    setCloudShareId(null);
    setMode(AppMode.CLOUD_SENDER);
    window.history.pushState({}, '', '/');
  };
  const openLegal = (path: string) => {
    setCloudShareId(null);
    setLegalPath(path);
    setMode(AppMode.LEGAL);
    window.history.pushState({}, '', path);
  };

  useEffect(() => {
    refreshAuth();
  }, []);

  // Signaling 연결 관리
  useEffect(() => {
    const initSignaling = async () => {
      try {
        console.log(
          '[App] Connecting to signaling server:',
          signalingFactory.getServerUrl()
        );
        await signalingFactory.connect();
        console.log(
          '[App] Signaling connected, using Rust:',
          signalingFactory.isUsingRust()
        );
      } catch (error: any) {
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
      <div className="relative w-screen h-screen overflow-hidden text-white bg-transparent font-rajdhani select-none">
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
          className="absolute top-0 left-0 w-full p-4 md:p-8 z-50 flex items-center justify-between cursor-pointer"
          onClick={() => {
            setCloudShareId(null);
            setMode(AppMode.INTRO);
            window.history.pushState({}, '', '/');
          }}
        >
          <div className="flex items-center gap-2 md:gap-4 hover:opacity-80 transition-opacity">
            <div className="w-8 h-8 md:w-10 md:h-10 border-2 border-cyan-500 rounded-full flex items-center justify-center backdrop-blur-sm bg-black/20 shadow-[0_0_15px_rgba(6,182,212,0.5)]">
              <div className="w-2 h-2 md:w-3 md:h-3 bg-white rounded-full shadow-[0_0_10px_rgba(255,255,255,1)] animate-pulse" />
            </div>
            <h1 className="text-xl md:text-3xl font-bold tracking-widest brand-font drop-shadow-lg">
              PONS<span className="text-cyan-500">WARP</span>
            </h1>
          </div>
          {/* Security Badge (Visual Assurance) */}
          <div
            className="hidden md:flex items-center gap-3"
            onClick={event => event.stopPropagation()}
          >
            <button
              onClick={openPricing}
              className="flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 font-bold tracking-wider hover:bg-emerald-500/20 transition-colors"
            >
              <CreditCard size={14} />
              <span>Pricing</span>
            </button>
            {authState.authenticated ? (
              <button
                onClick={signOut}
                className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-gray-300 font-mono hover:bg-white/10 transition-colors"
                title={authState.user?.email}
              >
                <User size={14} className="text-cyan-300" />
                <span className="max-w-[160px] truncate">
                  {authState.user?.email}
                </span>
                <LogOut size={13} />
              </button>
            ) : (
              <button
                onClick={signIn}
                disabled={authLoading}
                className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-gray-300 font-mono hover:bg-white/10 disabled:opacity-50 transition-colors"
              >
                <User size={14} className="text-cyan-300" />
                <span>{authLoading ? 'Checking' : 'Sign in'}</span>
              </button>
            )}
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-gray-400 font-mono">
              <ShieldCheck size={14} className="text-green-400" />
              <span>End-to-End Encrypted</span>
            </div>
          </div>
        </header>

        {/* 4. Main Content Area */}
        <main
          className={`relative z-10 w-full h-full ${
            mode === AppMode.PRICING ||
            mode === AppMode.LEGAL ||
            mode === AppMode.ADMIN
              ? 'overflow-hidden'
              : 'flex flex-col items-center justify-center p-4'
          }`}
        >
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
                    <span className="px-3 py-1 bg-cyan-500/10 border border-cyan-500/30 rounded-full text-xs font-bold text-cyan-300 tracking-wider uppercase flex items-center gap-1">
                      <Zap size={12} fill="currentColor" /> Next-Gen P2P
                    </span>
                  </div>
                  <h2 className="text-4xl md:text-7xl font-black brand-font tracking-tighter drop-shadow-[0_0_40px_rgba(6,182,212,0.4)] leading-tight">
                    HYPER-SPEED
                    <br />
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-purple-500 animate-gradient-x">
                      ZERO LIMITS.
                    </span>
                  </h2>
                  <p className="text-gray-400 text-sm md:text-xl max-w-2xl mx-auto leading-relaxed px-6">
                    Unlimited file transfer directly via your browser.
                    <br className="hidden md:block" />
                    No servers. No size caps. Just pure speed.
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row items-center gap-3">
                  <MagneticButton
                    onClick={startApp}
                    className="relative group bg-white text-black border border-white/50 px-8 py-3 md:px-12 md:py-5 rounded-full font-bold text-base md:text-lg tracking-widest hover:bg-cyan-500 hover:text-white hover:border-cyan-400 transition-all shadow-[0_0_30px_rgba(255,255,255,0.3)] overflow-hidden"
                  >
                    <span className="relative z-10 flex items-center gap-3">
                      INITIALIZE LINK
                      <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                    </span>
                  </MagneticButton>
                  <button
                    onClick={openPricing}
                    className="px-7 py-3 md:py-5 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-100 font-bold tracking-wider hover:bg-emerald-500/20 transition-colors"
                  >
                    VIEW PRICING
                  </button>
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
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 w-full items-center justify-center">
                  {/* SENDER CARD - 높이 축소 (Mobile: 200px, Desktop: 320px) */}
                  <MagneticButton
                    onClick={() => setMode(AppMode.SENDER)}
                    className="group relative flex flex-col items-center justify-center h-[200px] md:h-[320px] bg-black/40 backdrop-blur-xl border border-gray-700/50 rounded-[2rem] hover:border-cyan-500 transition-all duration-300 shadow-2xl w-full overflow-hidden"
                  >
                    <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

                    {/* 아이콘 크기 축소 */}
                    <div className="relative mb-4 md:mb-6 transform group-hover:scale-110 transition-transform duration-300">
                      <div className="absolute inset-0 bg-cyan-500 blur-2xl opacity-20 group-hover:opacity-50 transition-opacity" />
                      <div className="w-16 h-16 md:w-20 md:h-20 rounded-2xl bg-gray-800/80 border border-gray-600 group-hover:border-cyan-400 flex items-center justify-center relative z-10 shadow-lg">
                        <Send className="w-8 h-8 md:w-10 md:h-10 text-white" />
                      </div>
                    </div>

                    <div className="relative z-10 text-center space-y-1">
                      <h3 className="text-2xl md:text-4xl font-bold brand-font tracking-wider group-hover:text-cyan-400 transition-colors">
                        SEND
                      </h3>
                      <p className="text-gray-500 text-xs md:text-sm tracking-widest uppercase">
                        Create Gate
                      </p>
                    </div>
                  </MagneticButton>

                  {/* CLOUD CARD - 비동기 24시간 링크 공유 */}
                  <MagneticButton
                    onClick={() => setMode(AppMode.CLOUD_SENDER)}
                    className="group relative flex flex-col items-center justify-center h-[200px] md:h-[320px] bg-black/40 backdrop-blur-xl border border-gray-700/50 rounded-[2rem] hover:border-emerald-500 transition-all duration-300 shadow-2xl w-full overflow-hidden"
                  >
                    <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

                    <div className="relative mb-4 md:mb-6 transform group-hover:scale-110 transition-transform duration-300">
                      <div className="absolute inset-0 bg-emerald-500 blur-2xl opacity-20 group-hover:opacity-50 transition-opacity" />
                      <div className="w-16 h-16 md:w-20 md:h-20 rounded-2xl bg-gray-800/80 border border-gray-600 group-hover:border-emerald-400 flex items-center justify-center relative z-10 shadow-lg">
                        <CloudUpload className="w-8 h-8 md:w-10 md:h-10 text-white" />
                      </div>
                    </div>

                    <div className="relative z-10 text-center space-y-1">
                      <h3 className="text-2xl md:text-4xl font-bold brand-font tracking-wider group-hover:text-emerald-400 transition-colors">
                        CLOUD
                      </h3>
                      <p className="text-gray-500 text-xs md:text-sm tracking-widest uppercase">
                        24H Drop
                      </p>
                    </div>
                  </MagneticButton>

                  {/* RECEIVER CARD - 높이 축소 */}
                  <MagneticButton
                    onClick={() => setMode(AppMode.RECEIVER)}
                    className="group relative flex flex-col items-center justify-center h-[200px] md:h-[320px] bg-black/40 backdrop-blur-xl border border-gray-700/50 rounded-[2rem] hover:border-purple-500 transition-all duration-300 shadow-2xl w-full overflow-hidden"
                  >
                    <div className="absolute inset-0 bg-gradient-to-br from-purple-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

                    <div className="relative mb-4 md:mb-6 transform group-hover:scale-110 transition-transform duration-300">
                      <div className="absolute inset-0 bg-purple-500 blur-2xl opacity-20 group-hover:opacity-50 transition-opacity" />
                      <div className="w-16 h-16 md:w-20 md:h-20 rounded-2xl bg-gray-800/80 border border-gray-600 group-hover:border-purple-400 flex items-center justify-center relative z-10 shadow-lg">
                        <Download className="w-8 h-8 md:w-10 md:h-10 text-white" />
                      </div>
                    </div>

                    <div className="relative z-10 text-center space-y-1">
                      <h3 className="text-2xl md:text-4xl font-bold brand-font tracking-wider group-hover:text-purple-400 transition-colors">
                        RECEIVE
                      </h3>
                      <p className="text-gray-500 text-xs md:text-sm tracking-widest uppercase">
                        Join Gate
                      </p>
                    </div>
                  </MagneticButton>
                </div>
                <div className="mt-5 flex justify-center">
                  <button
                    onClick={openPricing}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-black/40 border border-emerald-500/30 text-emerald-200 text-xs font-bold tracking-widest hover:bg-emerald-500/15 transition-colors"
                  >
                    <CreditCard className="w-4 h-4" />
                    VIEW CLOUD DROP PRICING
                  </button>
                </div>
              </motion.div>
            )}

            {mode === AppMode.PRICING && (
              <PricingView
                authState={authState}
                authLoading={authLoading}
                onLogin={signIn}
                onAuthRefresh={refreshAuth}
                onOpenCloud={openCloudDrop}
              />
            )}

            {mode === AppMode.LEGAL && (
              <LegalPageView path={legalPath} onNavigate={openLegal} />
            )}

            {mode === AppMode.ADMIN && (
              <AdminDashboardView
                authState={authState}
                authLoading={authLoading}
                onLogin={signIn}
              />
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
                  className="fixed bottom-8 text-gray-500 hover:text-white transition-colors uppercase tracking-widest text-xs py-2 px-4 hover:bg-white/5 rounded-full"
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
                className="w-full h-full flex flex-col items-center justify-center pt-20 pb-10"
              >
                <CloudSenderView
                  authState={authState}
                  authLoading={authLoading}
                  onLogin={signIn}
                />

                <button
                  onClick={() => setMode(AppMode.SELECTION)}
                  className="fixed bottom-8 text-gray-500 hover:text-white transition-colors uppercase tracking-widest text-xs py-2 px-4 hover:bg-white/5 rounded-full"
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
                className="w-full h-full flex flex-col items-center justify-center pt-20 pb-10"
              >
                <CloudDownloadView shareId={cloudShareId} />

                <button
                  onClick={() => {
                    setCloudShareId(null);
                    setMode(AppMode.SELECTION);
                    window.history.pushState({}, '', '/');
                  }}
                  className="fixed bottom-8 text-gray-500 hover:text-white transition-colors uppercase tracking-widest text-xs py-2 px-4 hover:bg-white/5 rounded-full"
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
                className="w-full h-full flex flex-col items-center justify-center pt-20 pb-10"
              >
                <ReceiverView />

                <button
                  onClick={() => {
                    setMode(AppMode.SELECTION);
                    setRoomId(null);
                  }}
                  className="fixed bottom-8 text-gray-500 hover:text-white transition-colors uppercase tracking-widest text-xs py-2 px-4 hover:bg-white/5 rounded-full"
                >
                  Close Gate
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
        {mode !== AppMode.LEGAL && <LegalBeacon onNavigate={openLegal} />}
      </div>
    </ErrorBoundary>
  );
};

export default App;
