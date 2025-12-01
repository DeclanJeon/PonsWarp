import React, { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Upload, Folder, File as FileIcon, CheckCircle, Copy, Check, Loader2, FilePlus, AlertTriangle, Users, Lock } from 'lucide-react';
import { SwarmManager, MAX_DIRECT_PEERS } from '../services/swarmManager';
import { createManifest, formatBytes } from '../utils/fileUtils';
import { scanFiles, processInputFiles } from '../utils/fileScanner';
import { motion } from 'framer-motion';
import { AppMode } from '../types/types';
import { useTransferStore } from '../store/transferStore';
import { EncryptionService } from '../utils/encryption';

interface SenderViewProps {
  onComplete?: () => void;
}

const SenderView: React.FC<SenderViewProps> = () => {
  const { setStatus: setGlobalStatus, setEncryptionKey } = useTransferStore();
  const [manifest, setManifest] = useState<any>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<'IDLE' | 'PREPARING' | 'WAITING' | 'CONNECTING' | 'TRANSFERRING' | 'REMOTE_PROCESSING' | 'READY_FOR_NEXT' | 'DONE'>('IDLE');
  const [progressData, setProgressData] = useState({ progress: 0, speed: 0, bytesTransferred: 0, totalBytes: 0 });
  
  // 🚀 [Multi-Receiver] 피어 상태 추적
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [readyPeers, setReadyPeers] = useState<string[]>([]);
  const [readyCountdown, setReadyCountdown] = useState<number | null>(null);
  const [totalPeersToWait, setTotalPeersToWait] = useState<number>(0);
  const [completedPeers, setCompletedPeers] = useState<string[]>([]);
  const [queuedPeers, setQueuedPeers] = useState<string[]>([]);
  const [waitingPeersCount, setWaitingPeersCount] = useState(0);
  const [currentTransferPeerCount, setCurrentTransferPeerCount] = useState(0);
  
  // SwarmManager 인스턴스
  const swarmManagerRef = useRef<SwarmManager | null>(null);
  
  // Input Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // SwarmManager 인스턴스 생성
    const swarmManager = new SwarmManager();
    swarmManagerRef.current = swarmManager;

    // 이벤트 핸들러 등록
    swarmManager.on('status', (s: any) => {
      if (s === 'WAITING_FOR_PEER') setStatus('WAITING');
      if (s === 'CONNECTING') setStatus('CONNECTING');
      if (s === 'TRANSFERRING') setStatus('TRANSFERRING');
    });
    
    swarmManager.on('error', (errorMsg: string) => {
      console.error('[SenderView] SwarmManager error:', errorMsg);
      
      // 🚀 [수정] 치명적인 에러가 아니면 IDLE로 리셋하지 않음
      if (errorMsg.includes('disconnected') || errorMsg.includes('closed')) {
          // 단순 연결 끊김은 무시 (재접속 대기)
          return;
      }
      
      alert(`Transfer error: ${errorMsg}\n\nPlease try again.`);
      setStatus('IDLE');
    });

    // 🚀 [Multi-Receiver] 피어 이벤트
    swarmManager.on('peer-connected', (peerId: string) => {
      console.log('[SenderView] Peer connected:', peerId);
      setConnectedPeers((prev: string[]) => {
        // 중복 방지
        if (prev.includes(peerId)) return prev;
        return [...prev, peerId];
      });
    });

    // 🚀 [설계 10] Receiver가 방을 나가면 카운트에서 제거, 정보 삭제
    swarmManager.on('peer-disconnected', ({ peerId }: { peerId: string }) => {
      console.log('[SenderView] [설계 10] Peer disconnected:', peerId);
      setConnectedPeers((prev: string[]) => prev.filter((id: string) => id !== peerId));
      setReadyPeers((prev: string[]) => prev.filter((id: string) => id !== peerId));
      setCompletedPeers((prev: string[]) => prev.filter((id: string) => id !== peerId));
      setQueuedPeers((prev: string[]) => prev.filter((id: string) => id !== peerId));
      
      // 피어가 끊겨도 IDLE로 가지 않음 (다른 피어가 있을 수 있음)
      if (status === 'TRANSFERRING') {
          console.log('[SenderView] Peer disconnected during transfer. Continuing with remaining peers...');
      }
    });
    
    // 🚀 [설계 6,9] 방 유저 목록 업데이트 이벤트 (실시간 피어 카운트 반영)
    // Sender는 Receiver의 정보를 받고 방에 접속한 피어를 카운팅
    swarmManager.on('room-users-updated', ({ totalUsers, connectedPeers: peerCount }: { totalUsers: number; connectedPeers: number }) => {
      console.log('[SenderView] [설계 6,9] Room users updated:', { totalUsers, peerCount });
      // 실제 피어 카운트는 peer-connected/peer-disconnected 이벤트로 관리됨
    });

    swarmManager.on('peer-ready', (peerId: string) => {
      console.log('[SenderView] 🟢 [DEBUG] Peer ready:', peerId);
      console.log('[SenderView] 🟢 [DEBUG] Current status:', status);
      console.log('[SenderView] 🟢 [DEBUG] Current readyCountdown:', readyCountdown);
      console.log('[SenderView] 🟢 [DEBUG] Connected peers before update:', connectedPeers.length);
      console.log('[SenderView] 🟢 [DEBUG] Ready peers before update:', readyPeers.length);
      
      setReadyPeers((prev: string[]) => {
        // 중복 방지
        if (prev.includes(peerId)) return prev;
        const updated = [...prev, peerId];
        console.log('[SenderView] 🟢 [DEBUG] Ready peers updated:', updated);
        return updated;
      });
    });

    // 🚀 [수정] 카운트다운 핸들러 로직 강화
    const handleCountdownStart = ({ readyCount, totalCount, waitTime }: { readyCount: number; totalCount: number; waitTime: number }) => {
      console.log('[SenderView] ⏰ [DEBUG] Countdown signal received:', { readyCount, totalCount, waitTime });
      console.log('[SenderView] ⏰ [DEBUG] Current readyCountdown state before update:', readyCountdown);
      console.log('[SenderView] ⏰ [DEBUG] Current status:', status);
      console.log('[SenderView] ⏰ [DEBUG] Connected peers:', connectedPeers.length);
      console.log('[SenderView] ⏰ [DEBUG] Ready peers:', readyPeers.length);
      
      setTotalPeersToWait(totalCount);
      
      // 🚀 [수정] 카운트다운 강제 시작 (이전 상태와 관계없이)
      const countdownSeconds = waitTime / 1000;
      console.log('[SenderView] ⏰ [DEBUG] Setting countdown to:', countdownSeconds);
      setReadyCountdown(countdownSeconds);
    };
    
    // 🚀 [추가] 카운트다운 업데이트 핸들러 (인원수만 업데이트)
    const handleCountdownUpdate = ({ readyCount, totalCount }: { readyCount: number; totalCount: number }) => {
      console.log('[SenderView] ⏰ [DEBUG] Countdown update:', { readyCount, totalCount });
      console.log('[SenderView] ⏰ [DEBUG] Current readyCountdown:', readyCountdown);
      console.log('[SenderView] ⏰ [DEBUG] Connected peers:', connectedPeers.length);
      console.log('[SenderView] ⏰ [DEBUG] Ready peers:', readyPeers.length);
      
      setTotalPeersToWait(totalCount);
      // 카운트다운은 계속 진행
    };

    // 🚀 [수정] 즉시 시작 핸들러
    const handleAllReady = () => {
      console.log('[SenderView] ⚡ [DEBUG] All ready signal received. Clearing countdown and starting transfer.');
      console.log('[SenderView] ⚡ [DEBUG] Current readyCountdown before clearing:', readyCountdown);
      console.log('[SenderView] ⚡ [DEBUG] Current status:', status);
      console.log('[SenderView] ⚡ [DEBUG] Connected peers:', connectedPeers.length);
      console.log('[SenderView] ⚡ [DEBUG] Ready peers:', readyPeers.length);
      
      setReadyCountdown(null);
      // 상태를 TRANSFERRING으로 전환 (transfer-batch-start 이벤트가 오기 전에 미리)
      // setStatus('TRANSFERRING'); // transfer-batch-start에서 처리하므로 주석 처리
    };

    swarmManager.on('ready-countdown-start', handleCountdownStart);
    swarmManager.on('ready-countdown-update', handleCountdownUpdate);
    swarmManager.on('all-peers-ready', handleAllReady);

    // 🚀 [Multi-Receiver] 전송 배치 시작 이벤트
    swarmManager.on('transfer-batch-start', ({ peerCount }: { peerCount: number }) => {
      setCurrentTransferPeerCount(peerCount);
      setStatus('TRANSFERRING');
    });

    swarmManager.on('remote-processing', () => {
      setStatus('REMOTE_PROCESSING');
    });

    // 🚀 [Multi-Receiver] 피어 완료 이벤트
    swarmManager.on('peer-complete', (peerId: string) => {
      setCompletedPeers((prev: string[]) => [...prev, peerId]);
      // 완료된 피어는 readyPeers에서 제거
      setReadyPeers((prev: string[]) => prev.filter((id: string) => id !== peerId));
    });

    // 🚀 [설계 24-25] 전송 중 새 피어가 ready하면 대기열에 추가
    // Sender는 다음 순서가 이 피어라는 것을 기억
    swarmManager.on('peer-queued', ({ peerId, position }: { peerId: string; position?: number }) => {
      console.log('[SenderView] [설계 24-25] Peer queued:', peerId, 'position:', position);
      setQueuedPeers((prev: string[]) => [...prev, peerId]);
    });

    // 🚀 [Multi-Receiver] 다음 전송 준비 상태
    swarmManager.on('ready-for-next', ({ waitingCount }: { waitingCount: number }) => {
      setWaitingPeersCount(waitingCount);
      setStatus('READY_FOR_NEXT');
    });

    // 🚀 [Multi-Receiver] 배치 완료 (대기 중인 피어 있을 수 있음)
    swarmManager.on('batch-complete', ({ completedCount, waitingCount }: { completedCount: number; waitingCount?: number }) => {
      console.log('[SenderView] Batch complete:', { completedCount, waitingCount });
      setWaitingPeersCount(waitingCount || 0);
      setStatus('READY_FOR_NEXT');
    });

    // 🚀 [Multi-Receiver] 다음 전송 준비 중
    swarmManager.on('preparing-next-transfer', ({ queueSize }: { queueSize: number }) => {
      setCurrentTransferPeerCount(queueSize);
      setQueuedPeers([]); // 대기열 초기화
      setStatus('TRANSFERRING');
    });

    // 🚀 [Multi-Receiver] 대기열 처리 완료 이벤트
    swarmManager.on('queue-cleared', () => {
      setQueuedPeers([]); // 대기열 UI 초기화
    });

    // 🚀 [핵심 요구사항] 진행률/속도가 실제 데이터 전송과 정확히 일치해야 함
    swarmManager.on('progress', (data: any) => {
      // 진행률이 0으로 리셋되면 새 전송 시작
      if (data.progress === 0 && data.totalBytesSent === 0) {
        setProgressData({
          progress: 0,
          speed: 0,
          bytesTransferred: 0,
          totalBytes: data.totalBytes || 0
        });
      } else {
        // 🚀 [정확성] 실제 전송된 바이트 기반 진행률 계산
        const actualProgress = data.totalBytes > 0 
          ? Math.min((data.totalBytesSent / data.totalBytes) * 100, 100)
          : 0;
        
        setProgressData({
          progress: data.progress !== undefined ? data.progress : actualProgress,
          speed: data.speed || 0,
          bytesTransferred: data.totalBytesSent || data.bytesTransferred || 0,
          totalBytes: data.totalBytes || 0
        });
      }
    });

    swarmManager.on('all-transfers-complete', () => {
      console.log('[SenderView] 🎉 Received all-transfers-complete event, setting status to DONE');
      setStatus('DONE');
    });

    swarmManager.on('complete', () => {
      console.log('[SenderView] 🎉 Received complete event, setting status to DONE');
      setStatus('DONE');
    });

    return () => {
      swarmManager.off('ready-countdown-start', handleCountdownStart);
      swarmManager.off('ready-countdown-update', handleCountdownUpdate);
      swarmManager.off('all-peers-ready', handleAllReady);
      swarmManager.cleanup();
      swarmManager.removeAllListeners();
    };
  }, []);

  // 별도의 타이머 관리 Effect
  // 🚀 [수정] readyCountdown이 null이 아닐 때만 타이머 시작
  // readyCountdown 값이 변경될 때마다 interval을 재생성하지 않도록 수정
  const countdownActiveRef = useRef(false);
  
  useEffect(() => {
    // 카운트다운이 시작되었을 때만 타이머 설정
    if (readyCountdown !== null && readyCountdown > 0 && !countdownActiveRef.current) {
      countdownActiveRef.current = true;
      
      const interval = window.setInterval(() => {
        setReadyCountdown((prev) => {
          if (prev === null || prev <= 1) {
            countdownActiveRef.current = false;
            return null; // 0이 되면 종료
          }
          return prev - 1;
        });
      }, 1000);

      return () => {
        clearInterval(interval);
        countdownActiveRef.current = false;
      };
    }
    
    // readyCountdown이 null이 되면 플래그 리셋
    if (readyCountdown === null) {
      countdownActiveRef.current = false;
    }
  }, [readyCountdown !== null]); // 시작/종료 시에만 effect 실행

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const scannedFiles = processInputFiles(e.target.files);
      processScannedFiles(scannedFiles);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    useTransferStore.setState({ status: 'DRAGGING_FILES' });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    useTransferStore.setState({ status: 'IDLE' });
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    useTransferStore.setState({ status: 'IDLE' });
    
    // DataTransferItemList가 있으면 FileSystemEntry 스캔 사용
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      const scannedFiles = await scanFiles(e.dataTransfer.items);
      processScannedFiles(scannedFiles);
    } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      // Fallback: 단순 파일 처리
      const scannedFiles = processInputFiles(e.dataTransfer.files);
      processScannedFiles(scannedFiles);
    }
  };

  const processScannedFiles = async (scannedFiles: any[]) => {
    if (scannedFiles.length === 0) return;
    
    // 신규 전송 로직
    // 🔐 암호화 키 생성
    const encryptionKey = await EncryptionService.generateKey();
    setEncryptionKey(encryptionKey);
    
    // Manifest 생성
    const { manifest, files } = createManifest(scannedFiles);
    setManifest(manifest);
    
    console.log('[SenderView] 📊 [DEBUG] Manifest created:', {
      isFolder: manifest.isFolder,
      totalFiles: manifest.totalFiles,
      totalSize: manifest.totalSize,
      rootName: manifest.rootName
    });
    
    // 여러 파일이면 ZIP 압축 준비 중 표시
    if (files.length > 1) {
      setStatus('PREPARING');
    } else {
      setStatus('WAITING');
    }
    
    const id = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomId(id);
    // 🔐 암호화 키를 URL 해시에 포함
    setShareLink(`${window.location.origin}/receive/${id}#${encryptionKey}`);
    
    console.log('[SenderView] 🏠 [DEBUG] Room created:', id);
    console.log('[SenderView] 🔐 [DEBUG] Encryption key generated and added to URL hash');
    
    try {
      console.log('[SenderView] 🚀 [DEBUG] Initializing SwarmManager...');
      // 암호화 키를 워커에 전달
      await swarmManagerRef.current?.initSender(manifest, files, id, encryptionKey);
      console.log('[SenderView] ✅ [DEBUG] SwarmManager initialized successfully');
      
      // 초기화 완료 후 WAITING 상태로 전환
      setStatus('WAITING');
    } catch (error: any) {
      console.error('[SenderView] ❌ [DEBUG] Init failed:', error);
      
      alert(`Failed to initialize transfer: ${error?.message || 'Unknown error'}\n\nPlease try again with different files.`);
      setStatus('IDLE');
    }
  };

  const copyToClipboard = async () => {
    if (shareLink) {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full w-full max-w-2xl mx-auto p-6 z-10 relative">
      
      {status === 'IDLE' && (
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full space-y-4"
        >
           <div
             onDragEnter={handleDragEnter}
             onDragOver={handleDragOver}
             onDragLeave={handleDragLeave}
             onDrop={handleDrop}
             className="border-2 border-dashed border-cyan-500/50 bg-black/40 backdrop-blur-md rounded-3xl p-10 text-center transition-all flex flex-col items-center justify-center min-h-[320px]"
           >
             <input 
               type="file" 
               className="hidden" 
               ref={fileInputRef} 
               onChange={handleFileSelect}
               multiple 
             />
             <input
               type="file"
               className="hidden"
               ref={folderInputRef}
               onChange={handleFileSelect}
               multiple
               {...({ webkitdirectory: "" } as any)}
             />

             <div className="mb-8">
                <div className="w-20 h-20 bg-cyan-900/20 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
                     <Upload className="w-10 h-10 text-cyan-400" />
                </div>
                <h2 className="text-3xl font-bold mb-2">Drag & Drop</h2>
                <p className="text-cyan-200/60 text-lg">Files or Folders</p>
             </div>

             <div className="flex gap-4 w-full max-w-md">
               <button 
                 onClick={() => fileInputRef.current?.click()}
                 className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-white py-4 rounded-xl flex flex-col items-center gap-2 transition-all group"
               >
                 <FilePlus className="w-6 h-6 text-cyan-400 group-hover:scale-110 transition-transform"/>
                 <span className="font-bold">Select Files</span>
               </button>

               <button 
                 onClick={() => folderInputRef.current?.click()}
                 className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-white py-4 rounded-xl flex flex-col items-center gap-2 transition-all group"
               >
                 <Folder className="w-6 h-6 text-yellow-400 group-hover:scale-110 transition-transform"/>
                 <span className="font-bold">Select Folder</span>
               </button>
             </div>
           </div>
        </motion.div>
      )}

      {status === 'PREPARING' && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center p-8 bg-cyan-900/20 rounded-3xl border border-cyan-500/30 max-w-lg w-full"
        >
          <div className="relative w-20 h-20 mx-auto mb-6">
            <Loader2 className="w-full h-full text-cyan-500 animate-spin" />
          </div>
          
          <h2 className="text-2xl font-bold text-white mb-2">Preparing Files...</h2>
          <p className="text-gray-400 mb-4">
            Compressing {manifest?.totalFiles} files into ZIP archive
          </p>
          <p className="text-sm text-gray-500">
            This may take a moment for large folders. Please wait...
          </p>
        </motion.div>
      )}

      {status === 'WAITING' && roomId && shareLink && (
        <motion.div className="bg-black/60 backdrop-blur-xl p-8 rounded-3xl border border-cyan-500/30 flex flex-col items-center max-w-md w-full">
          <h3 className="text-xl mb-4 font-bold tracking-widest text-cyan-400">READY TO WARP</h3>
          
          {/* 🔐 암호화 활성화 표시 */}
          <div className="flex items-center gap-2 mb-4 bg-green-900/20 px-3 py-2 rounded-lg border border-green-500/30">
            <Lock className="w-4 h-4 text-green-400" />
            <span className="text-sm text-green-400">End-to-End Encrypted</span>
          </div>
          
          <div className="bg-white p-4 rounded-xl mb-6 shadow-[0_0_20px_rgba(6,182,212,0.3)]">
            <QRCodeSVG value={shareLink} size={180} />
          </div>
          <p className="text-3xl font-mono font-bold mb-4 tracking-widest">{roomId}</p>
          
          {/* 🚀 [Multi-Receiver] 피어 상태 표시 */}
          <div className="w-full bg-gray-900/50 p-3 rounded-lg mb-4 border border-gray-700">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-cyan-400" />
                <span className="text-sm text-gray-300">Receivers</span>
              </div>
              <div className="flex items-center gap-1">
                {[...Array(MAX_DIRECT_PEERS)].map((_, i) => {
                  const isConnected = i < connectedPeers.length;
                  const isReady = i < readyPeers.length;
                  return (
                    <div
                      key={i}
                      className={`w-3 h-3 rounded-full transition-colors ${
                        isConnected
                          ? (isReady ? 'bg-green-500 shadow-[0_0_5px_#22c55e]' : 'bg-cyan-500')
                          : 'bg-gray-700'
                      }`}
                    />
                  );
                })}
                <span className="ml-2 text-sm font-mono text-gray-400">
                  {readyPeers.length}/{connectedPeers.length} Ready
                </span>
              </div>
            </div>
          </div>
          
          <div className="w-full bg-gray-900/50 p-4 rounded-lg mb-4 text-left border border-gray-700">
             <div className="flex items-center gap-3 mb-2">
               {manifest?.isFolder ? <Folder className="text-yellow-500"/> : <FileIcon className="text-blue-500"/>}
               <span className="font-bold truncate text-lg">{manifest?.rootName}</span>
             </div>
             <p className="text-xs text-gray-400 pl-9">
               {manifest?.totalFiles} files • {formatBytes(manifest?.totalSize || 0)}
             </p>
          </div>

          <div className="flex gap-2 w-full">
            <div className="flex-1 bg-gray-800 rounded px-3 py-2 text-xs text-gray-400 truncate leading-8 font-mono">
              {shareLink}
            </div>
            <button onClick={copyToClipboard} className="bg-cyan-600 hover:bg-cyan-500 text-white p-2 rounded transition-colors">
              {copied ? <Check size={16}/> : <Copy size={16}/>}
            </button>
          </div>
          
          <div className="mt-6 text-center h-16 flex items-center justify-center">
            {readyCountdown !== null ? (
              // 🚀 [설계 17] 카운트다운 UI (강조)
              <div className="bg-yellow-500/20 border border-yellow-500/50 px-6 py-3 rounded-xl w-full animate-pulse flex flex-col items-center">
                <p className="text-yellow-400 font-bold text-lg leading-none mb-1">
                  Starting in {readyCountdown}s...
                </p>
                <p className="text-[10px] text-yellow-200 uppercase tracking-wider">
                  Waiting for other receivers ({readyPeers.length}/{totalPeersToWait})
                </p>
              </div>
            ) : (
              // 대기 중 메시지
              <div className="text-gray-500 text-sm flex flex-col items-center">
                 {connectedPeers.length === 0 ? (
                    <div className="flex items-center gap-2">
                        <Loader2 className="animate-spin w-4 h-4"/>
                        <span>Waiting for connections...</span>
                    </div>
                 ) : (
                    <div className="flex items-center gap-2 text-cyan-400">
                        <Loader2 className="animate-spin w-4 h-4"/>
                        <span>Waiting for receivers to start download...</span>
                    </div>
                 )}
              </div>
            )}
          </div>
        </motion.div>
      )}

      {(status === 'TRANSFERRING' || status === 'CONNECTING') && (
        <div className="w-full space-y-6 max-w-lg">
          <div className="text-center">
             <h2 className="text-2xl font-bold mb-2 animate-pulse">Warping Data...</h2>
             <p className="text-cyan-400 text-2xl font-mono">{progressData.progress.toFixed(1)}%</p>
          </div>
          
          {/* 🚀 [Multi-Receiver] 피어 상태 표시 */}
          <div className="flex justify-center gap-2 mb-4">
            <div className="flex items-center gap-2 bg-gray-900/50 px-4 py-2 rounded-full border border-gray-700">
              <Users className="w-4 h-4 text-cyan-400" />
              <span className="text-sm text-gray-300">
                Sending to {currentTransferPeerCount || readyPeers.length} receiver{(currentTransferPeerCount || readyPeers.length) !== 1 ? 's' : ''}
              </span>
            </div>
            {queuedPeers.length > 0 && (
              <div className="flex items-center gap-2 bg-yellow-900/30 px-4 py-2 rounded-full border border-yellow-700">
                <span className="text-sm text-yellow-300">{queuedPeers.length} in queue</span>
              </div>
            )}
          </div>
          
          <div className="relative h-4 bg-gray-800 rounded-full overflow-hidden border border-gray-700">
            <motion.div
              className="absolute top-0 left-0 h-full bg-gradient-to-r from-cyan-500 to-purple-600"
              initial={{ width: 0 }}
              animate={{ width: `${progressData.progress}%` }}
            />
          </div>

          <div className="grid grid-cols-3 gap-4 text-center">
             <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
               <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Speed</p>
               <p className="font-mono font-bold text-cyan-300">{formatBytes(progressData.speed)}/s</p>
             </div>
             <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
               <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Sent</p>
               <p className="font-mono text-gray-300">{formatBytes(progressData.bytesTransferred)}</p>
             </div>
             <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
               <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Total</p>
               <p className="font-mono text-gray-300">{formatBytes(progressData.totalBytes)}</p>
             </div>
          </div>
        </div>
      )}

      {status === 'REMOTE_PROCESSING' && (
        <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center p-8 bg-yellow-900/20 rounded-3xl border border-yellow-500/30 max-w-lg w-full"
        >
            <div className="relative w-20 h-20 mx-auto mb-6">
                <Loader2 className="w-full h-full text-yellow-500 animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-xs font-bold text-white">WAIT</span>
                </div>
            </div>
            
            <h2 className="text-2xl font-bold text-white mb-2">Sending Completed...</h2>
            <h3 className="text-xl text-yellow-400 font-bold mb-6 animate-pulse">Waiting for Receivers to Save</h3>
            
            <div className="bg-black/40 p-4 rounded-xl text-left flex gap-3 border border-yellow-500/20">
                <AlertTriangle className="w-6 h-6 text-yellow-500 flex-shrink-0" />
                <div className="text-sm text-gray-300">
                    <p className="font-bold text-white mb-1">Do NOT close this window.</p>
                    <p>The receivers are currently saving files. The connection must remain open until they finish downloading.</p>
                </div>
            </div>
        </motion.div>
      )}

      {/* 🚀 [Multi-Receiver] 다음 전송 대기 상태 */}
      {status === 'READY_FOR_NEXT' && (
        <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center p-8 bg-cyan-900/20 rounded-3xl border border-cyan-500/30 max-w-lg w-full"
        >
            <div className="relative w-20 h-20 mx-auto mb-6">
                <CheckCircle className="w-full h-full text-green-500" />
            </div>
            
            <h2 className="text-2xl font-bold text-white mb-2">Transfer Batch Complete</h2>
            <p className="text-gray-400 mb-4">
              {completedPeers.length} receiver(s) have successfully downloaded files.
            </p>
            
            {/* 피어 상태 표시 */}
            <div className="w-full bg-gray-900/50 p-4 rounded-lg mb-6 border border-gray-700">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-cyan-400" />
                  <span className="text-sm text-gray-300">Receiver Status</span>
                </div>
              </div>
              <div className="space-y-2 text-left">
                {connectedPeers.map((peerId: string, i: number) => (
                  <div key={peerId} className="flex items-center justify-between text-sm">
                    <span className="text-gray-400">Receiver {i + 1}</span>
                    <span className={`px-2 py-1 rounded text-xs ${
                      completedPeers.includes(peerId) 
                        ? 'bg-green-900/50 text-green-400' 
                        : queuedPeers.includes(peerId)
                          ? 'bg-yellow-900/50 text-yellow-400'
                          : 'bg-gray-800 text-gray-400'
                    }`}>
                      {completedPeers.includes(peerId) 
                        ? '✓ Complete' 
                        : queuedPeers.includes(peerId)
                          ? '⏳ In Queue'
                          : '○ Waiting'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            
            {waitingPeersCount > 0 ? (
              <div className="bg-black/40 p-4 rounded-xl text-left flex gap-3 border border-cyan-500/20 mb-4">
                <Loader2 className="w-6 h-6 text-cyan-500 animate-spin flex-shrink-0" />
                <div className="text-sm text-gray-300">
                  <p className="font-bold text-white mb-1">Waiting for {waitingPeersCount} more receiver(s)</p>
                  <p>Keep this window open. Transfer will start automatically when they click "Start Download".</p>
                </div>
              </div>
            ) : (
              <div className="bg-black/40 p-4 rounded-xl text-left flex gap-3 border border-gray-700 mb-4">
                <AlertTriangle className="w-6 h-6 text-gray-500 flex-shrink-0" />
                <div className="text-sm text-gray-300">
                  <p className="font-bold text-white mb-1">No more receivers waiting</p>
                  <p>You can send another file or close this window.</p>
                </div>
              </div>
            )}
            
            <button
              onClick={() => window.location.reload()}
              className="bg-white text-black px-8 py-3 rounded-full font-bold hover:bg-cyan-50 transition-colors"
            >
              Send New Files
            </button>
        </motion.div>
      )}

      {status === 'DONE' && (
        <div className="text-center">
          <CheckCircle className="w-24 h-24 text-green-500 mx-auto mb-6" />
          <h2 className="text-3xl font-bold mb-2">Transfer Successful!</h2>
          <p className="text-gray-400 mb-8">
            {connectedPeers.length > 1 
              ? `All ${connectedPeers.length} receivers have successfully saved files.`
              : 'The receiver has successfully saved files.'}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="bg-white text-black px-8 py-3 rounded-full font-bold hover:bg-cyan-50 transition-colors"
          >
            Send Another
          </button>
        </div>
      )}
    </div>
  );
};

export default SenderView;
