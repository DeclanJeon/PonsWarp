import React, { useState, useEffect } from 'react';
import { Send, Download, ArrowRight } from 'lucide-react';
import WarpBackground from './components/WarpBackground';
import SenderView from './components/SenderView';
import ReceiverView from './components/ReceiverView';
import { AppMode } from './types';
import { motion, AnimatePresence } from 'framer-motion';
import { signalingService } from './services/signaling';
import { MagneticButton } from './components/ui/MagneticButton';
import { TransferProgressBar } from './components/ui/TransferProgressBar';

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>(AppMode.INTRO);
  const [autoRoomId, setAutoRoomId] = useState<string | null>(null);

  // URL 파라미터 체크 (앱 로드 시)
  useEffect(() => {
    const path = window.location.pathname;
    const match = path.match(/^\/receive\/([A-Z0-9]{6})$/);
    
    if (match) {
      const roomId = match[1];
      setAutoRoomId(roomId);
      setMode(AppMode.RECEIVER);
    }
  }, []);

  const startApp = () => setMode(AppMode.SELECTION);

  // Signaling 연결 관리 (async/await)
  useEffect(() => {
    let mounted = true;
    
    const initSignaling = async () => {
      if (signalingService.isConnected()) {
        console.log('[App] Signaling already connected');
        return;
      }

      try {
        console.log('[App] Initializing signaling connection');
        await signalingService.connect(); // 연결 대기
        
        if (mounted) {
          console.log('[App] Signaling connection established');
        }
      } catch (error) {
        console.error('[App] Failed to connect to signaling server:', error);
      }
    };

    initSignaling();

    return () => {
      mounted = false;
      // ✅ 개발 모드에서는 cleanup 하지 않음
      console.log('[App] Component cleanup');
      // 프로덕션 환경에서만 연결 해제
      // signalingService.disconnect();
    };
  }, []);

  // Determine intensity based on mode
  const intensity = (mode === AppMode.TRANSFERRING) ? 'hyper' : 'low';

  return (
    <div className="relative w-screen h-screen overflow-hidden text-white bg-transparent">
      {/* Visual Background */}
      <WarpBackground intensity={intensity} />

      {/* Header / Logo */}
      <header className="absolute top-0 left-0 p-6 z-50 flex items-center gap-3 pointer-events-none">
        <div className="w-10 h-10 border-2 border-cyan-500 rounded-full flex items-center justify-center">
          <div className="w-4 h-4 bg-white rounded-full shadow-[0_0_15px_rgba(255,255,255,0.8)]" />
        </div>
        <h1 className="text-2xl font-bold tracking-tighter brand-font">
          PONS<span className="text-cyan-500">WARP</span>
        </h1>
      </header>

      <main className="relative z-10 w-full h-full flex flex-col items-center justify-center">
        <AnimatePresence mode="wait">
          
          {mode === AppMode.INTRO && (
            <motion.div 
              key="intro"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, scale: 1.1 }}
              className="text-center max-w-xl px-6"
            >
              <h2 className="text-5xl md:text-7xl font-black mb-6 leading-tight brand-font">
                FILE TRANSFER <br/>
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-purple-600">
                  AT WARP SPEED
                </span>
              </h2>
              <p className="text-gray-400 mb-10 text-lg">
                P2P. Multi-Channel. 10GB+ Ready.
              </p>
              <MagneticButton 
                onClick={startApp}
                className="bg-white text-black px-10 py-4 rounded-full font-bold tracking-wider hover:bg-cyan-50 transition-all flex items-center gap-2 mx-auto"
              >
                INITIALIZE
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </MagneticButton>
            </motion.div>
          )}

          {mode === AppMode.SELECTION && (
            <motion.div 
              key="selection"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl w-full px-6"
            >
              <MagneticButton 
                onClick={() => setMode(AppMode.SENDER)}
                className="group h-64 bg-black/40 backdrop-blur-md border border-gray-800 rounded-3xl p-8 flex flex-col items-center justify-center hover:border-cyan-500 hover:bg-cyan-950/30 transition-all"
              >
                <div className="w-20 h-20 rounded-2xl bg-gray-900 group-hover:bg-cyan-500/20 flex items-center justify-center mb-6 transition-colors">
                  <Send className="w-10 h-10 text-white" />
                </div>
                <h3 className="text-2xl font-bold mb-2">SEND FILE</h3>
                <p className="text-gray-500 text-sm">Generate Warp Key</p>
              </MagneticButton>

              <MagneticButton 
                onClick={() => setMode(AppMode.RECEIVER)}
                className="group h-64 bg-black/40 backdrop-blur-md border border-gray-800 rounded-3xl p-8 flex flex-col items-center justify-center hover:border-purple-500 hover:bg-purple-950/30 transition-all"
              >
                 <div className="w-20 h-20 rounded-2xl bg-gray-900 group-hover:bg-purple-500/20 flex items-center justify-center mb-6 transition-colors">
                  <Download className="w-10 h-10 text-white" />
                </div>
                <h3 className="text-2xl font-bold mb-2">RECEIVE FILE</h3>
                <p className="text-gray-500 text-sm">Scan Warp Key</p>
              </MagneticButton>
            </motion.div>
          )}

          {(mode === AppMode.SENDER || mode === AppMode.TRANSFERRING) && (
            <motion.div key="sender" className="w-full h-full flex flex-col items-center justify-center">
              <SenderView onComplete={() => setMode(AppMode.COMPLETED)} />
              
              {/* 🚀 [최적화] 전송 중일 때만 최적화된 프로그레스 바 표시 */}
              {mode === AppMode.TRANSFERRING && (
                <div className="mt-8">
                  <TransferProgressBar />
                </div>
              )}
              
              <button 
                onClick={() => setMode(AppMode.SELECTION)} 
                className="absolute bottom-8 text-gray-500 hover:text-white transition-colors"
              >
                Cancel Transfer
              </button>
            </motion.div>
          )}

          {mode === AppMode.RECEIVER && (
            <motion.div key="receiver" className="w-full h-full flex items-center justify-center">
              <ReceiverView autoRoomId={autoRoomId} />
              <button
                onClick={() => {
                  setMode(AppMode.SELECTION);
                  setAutoRoomId(null);
                }}
                className="absolute bottom-8 text-gray-500 hover:text-white"
              >
                Cancel Transfer
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

export default App;