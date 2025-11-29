import React, { useEffect } from 'react';
import { Send, Download, ArrowRight } from 'lucide-react';
import SpaceField from './components/SpaceField';
import SenderView from './components/SenderView';
import ReceiverView from './components/ReceiverView';
import { AppMode } from './types/types';
import { motion, AnimatePresence } from 'framer-motion';
import { signalingService } from './services/signaling';
import { MagneticButton } from './components/ui/MagneticButton';
import { TransferProgressBar } from './components/ui/TransferProgressBar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastContainer } from './components/ui/ToastContainer';
import { StatusOverlay } from './components/ui/StatusOverlay';
import { useTransferStore } from './store/transferStore';
import { toast } from './store/toastStore';
// import initWasm, { init_wasm, add_numbers } from './wasm-pkg/ponswarp_wasm';

const App: React.FC = () => {
  // 전역 스토어 사용 (SpaceField와 동기화)
  const { mode, setMode, setRoomId, status } = useTransferStore();

  // 🚀 [Step 1] WASM 초기화 및 테스트
  useEffect(() => {
    const loadWasm = async () => {
      try {
        console.log('[App] 🔄 Starting WASM module loading...');
        // 동적 import로 WASM 모듈 로드
        const wasmModule = await import('./wasm-pkg/ponswarp_wasm.js');
        console.log('[App] ✅ WASM module loaded successfully');
        await wasmModule.default(); // WASM 모듈 초기화
        console.log('[App] ✅ WASM module initialized');
        wasmModule.init_wasm(); // Rust 내부 초기화 로그 출력
        
        // 연산 테스트
        const result = wasmModule.add_numbers(10, 20);
        console.log(`[App] 🦀 Rust WASM Test: 10 + 20 = ${result}`);
        
        if (result === 30) {
            toast.success('System Core (WASM) Initialized');
            console.log('[App] 🎉 WASM initialization complete!');
        }
      } catch (e) {
        console.error('[App] ❌ Failed to load WASM module:', e);
        toast.error('System Core Failure');
      }
    };
    loadWasm();
  }, []);

  // URL 파라미터 체크 (앱 로드 시)
  useEffect(() => {
    const path = window.location.pathname;
    const match = path.match(/^\/receive\/([A-Z0-9]{6})$/);
    
    if (match) {
      const roomId = match[1];
      setRoomId(roomId);
      setMode(AppMode.RECEIVER);
    }
    
    // 글로벌 에러 핸들러
    const handleRejection = (event: PromiseRejectionEvent) => {
      toast.error(`Unexpected Error: ${event.reason?.message || 'Unknown'}`);
    };
    window.addEventListener('unhandledrejection', handleRejection);
    
    return () => window.removeEventListener('unhandledrejection', handleRejection);
  }, [setRoomId, setMode]);

  const startApp = () => setMode(AppMode.SELECTION);

  // Signaling 연결 관리
  useEffect(() => {
    const initSignaling = async () => {
      try {
        await signalingService.connect();
      } catch (error: any) {
        toast.error('Failed to connect to signaling server');
        console.error('[App] Signaling connection failed:', error);
      }
    };
    
    initSignaling();
  }, []);

  return (
    <ErrorBoundary>
      <div className="relative w-screen h-screen overflow-hidden text-white bg-transparent font-rajdhani select-none">
        
        {/* 배경 계층 */}
        <SpaceField />
        
        {/* 오버레이 계층 */}
        <StatusOverlay />
        <ToastContainer />
        
        {/* 플래시 효과 */}
        {status === 'DONE' && (
          <motion.div
            className="fixed inset-0 bg-cyan-400 pointer-events-none z-40 mix-blend-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.6, 0] }}
            transition={{ duration: 1.0, ease: "circOut" }}
          />
        )}
        
        {/* Header */}
        <header
          className="absolute top-0 left-0 p-8 z-50 flex items-center gap-4 cursor-pointer hover:opacity-80 transition-opacity"
          onClick={() => { 
            setMode(AppMode.INTRO); 
            window.history.pushState({}, '', '/'); 
          }}
        >
          <div className="w-12 h-12 border-2 border-cyan-500 rounded-full flex items-center justify-center backdrop-blur-sm bg-black/20 shadow-[0_0_15px_rgba(6,182,212,0.5)]">
            <div className="w-4 h-4 bg-white rounded-full shadow-[0_0_10px_rgba(255,255,255,1)] animate-pulse" />
          </div>
          <h1 className="text-3xl font-bold tracking-widest brand-font drop-shadow-lg">
            PONS<span className="text-cyan-500">WARP</span>
          </h1>
        </header>

        {/* 메인 컨텐츠 */}
        <main className="relative z-10 w-full h-full flex flex-col items-center justify-center p-6">
          <AnimatePresence mode="wait">
            
            {mode === AppMode.INTRO && (
              <motion.div 
                key="intro"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20, filter: "blur(10px)" }}
                className="text-center max-w-2xl"
              >
                <h2 className="text-6xl md:text-8xl font-black mb-8 leading-tight brand-font tracking-tighter drop-shadow-[0_0_30px_rgba(6,182,212,0.3)]">
                  WARP SPEED <br/>
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-white to-purple-500 animate-gradient-x">
                    FILE TRANSFER
                  </span>
                </h2>
                <MagneticButton 
                  onClick={startApp}
                  className="bg-white/10 backdrop-blur-md border border-white/20 text-white px-12 py-6 rounded-full font-bold text-xl tracking-widest hover:bg-cyan-500 hover:border-cyan-400 transition-all flex items-center gap-4 mx-auto group shadow-[0_0_20px_rgba(0,0,0,0.5)]"
                >
                  INITIALIZE SYSTEM
                  <ArrowRight className="w-6 h-6 group-hover:translate-x-2 transition-transform" />
                </MagneticButton>
              </motion.div>
            )}

            {mode === AppMode.SELECTION && (
              <motion.div 
                key="selection"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.1, filter: "blur(10px)" }}
                className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl w-full"
              >
                <MagneticButton 
                  onClick={() => setMode(AppMode.SENDER)}
                  className="group h-80 bg-black/30 backdrop-blur-xl border border-gray-700/50 rounded-[2rem] p-10 flex flex-col items-center justify-center hover:border-cyan-500 hover:bg-cyan-900/20 transition-all duration-500 shadow-2xl"
                >
                  <div className="relative mb-8">
                    <div className="absolute inset-0 bg-cyan-500 blur-2xl opacity-0 group-hover:opacity-40 transition-opacity duration-500" />
                    <div className="w-24 h-24 rounded-3xl bg-gray-800/50 border border-gray-600 group-hover:border-cyan-400 flex items-center justify-center relative z-10 transition-colors">
                      <Send className="w-10 h-10 text-white group-hover:scale-110 transition-transform duration-300" />
                    </div>
                  </div>
                  <h3 className="text-3xl font-bold mb-3 tracking-wider group-hover:text-cyan-400 transition-colors">SEND</h3>
                  <p className="text-gray-400 text-sm tracking-widest uppercase">Create Warp Gate</p>
                </MagneticButton>

                <MagneticButton 
                  onClick={() => setMode(AppMode.RECEIVER)}
                  className="group h-80 bg-black/30 backdrop-blur-xl border border-gray-700/50 rounded-[2rem] p-10 flex flex-col items-center justify-center hover:border-purple-500 hover:bg-purple-900/20 transition-all duration-500 shadow-2xl"
                >
                  <div className="relative mb-8">
                    <div className="absolute inset-0 bg-purple-500 blur-2xl opacity-0 group-hover:opacity-40 transition-opacity duration-500" />
                    <div className="w-24 h-24 rounded-3xl bg-gray-800/50 border border-gray-600 group-hover:border-purple-400 flex items-center justify-center relative z-10 transition-colors">
                      <Download className="w-10 h-10 text-white group-hover:scale-110 transition-transform duration-300" />
                    </div>
                  </div>
                  <h3 className="text-3xl font-bold mb-3 tracking-wider group-hover:text-purple-400 transition-colors">RECEIVE</h3>
                  <p className="text-gray-400 text-sm tracking-widest uppercase">Connect to Gate</p>
                </MagneticButton>
              </motion.div>
            )}

            {(mode === AppMode.SENDER || status === 'TRANSFERRING') && (
              <motion.div 
                key="sender" 
                className="w-full h-full flex flex-col items-center justify-center"
              >
                <SenderView />
                {status === 'TRANSFERRING' && (
                  <div className="mt-12 w-full max-w-xl">
                    <TransferProgressBar />
                  </div>
                )}
                <button 
                  onClick={() => setMode(AppMode.SELECTION)} 
                  className="absolute bottom-10 text-gray-500 hover:text-white transition-colors uppercase tracking-widest text-xs"
                >
                  Abort Mission
                </button>
              </motion.div>
            )}

            {mode === AppMode.RECEIVER && (
              <motion.div 
                key="receiver" 
                className="w-full h-full flex flex-col items-center justify-center"
              >
                <ReceiverView />
                <button
                  onClick={() => {
                    setMode(AppMode.SELECTION);
                    setRoomId(null);
                  }}
                  className="absolute bottom-10 text-gray-500 hover:text-white transition-colors uppercase tracking-widest text-xs"
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