// 🚨 [DEBUG] 아키텍처 불일치 진단 로그 추가
console.log('[SenderView] ✅ [DEBUG] ARCHITECTURE CONSISTENT:');
console.log('[SenderView] ✅ [DEBUG] - Using SwarmManager (correct)');
console.log(
  '[SenderView] ✅ [DEBUG] - SwarmManager uses SinglePeerConnection (correct)'
);
console.log(
  '[SenderView] ✅ [DEBUG] - Dedicated Sender implementation (correct)'
);

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Upload,
  Folder,
  File as FileIcon,
  CheckCircle,
  Copy,
  Check,
  Loader2,
  FilePlus,
  AlertTriangle,
  Users,
} from 'lucide-react';
import { SwarmManager, MAX_DIRECT_PEERS } from '../services/swarmManager';
import { createManifest, formatBytes } from '../utils/fileUtils';
import { scanFiles, processInputFiles } from '../utils/fileScanner';
import { motion } from 'framer-motion';
import { AppMode } from '../types/types';
import { useTransferStore } from '../store/transferStore';

interface SenderViewProps {
  onComplete?: () => void;
}

const SenderView: React.FC<SenderViewProps> = () => {
  const { setStatus: setGlobalStatus } = useTransferStore();
  const [manifest, setManifest] = useState<any>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<
    | 'IDLE'
    | 'PREPARING'
    | 'WAITING'
    | 'CONNECTING'
    | 'TRANSFERRING'
    | 'REMOTE_PROCESSING'
    | 'READY_FOR_NEXT'
    | 'DONE'
  >('IDLE');
  const [progressData, setProgressData] = useState({
    progress: 0,
    speed: 0,
    bytesTransferred: 0,
    totalBytes: 0,
  });

  // 🚀 [Multi-Receiver] 피어 상태 추적
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [readyPeers, setReadyPeers] = useState<string[]>([]);
  const [readyCountdown, setReadyCountdown] = useState<number | null>(null);
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
      alert(`Transfer error: ${errorMsg}\n\nPlease try again.`);
      setStatus('IDLE');
    });

    // 🚀 [Multi-Receiver] 피어 이벤트
    swarmManager.on('peer-connected', (peerId: string) => {
      setConnectedPeers((prev: string[]) => [...prev, peerId]);
    });

    swarmManager.on('peer-disconnected', ({ peerId }: { peerId: string }) => {
      setConnectedPeers((prev: string[]) =>
        prev.filter((id: string) => id !== peerId)
      );
      setReadyPeers((prev: string[]) =>
        prev.filter((id: string) => id !== peerId)
      );
    });

    swarmManager.on('peer-ready', (peerId: string) => {
      setReadyPeers((prev: string[]) => [...prev, peerId]);
    });

    // 🚀 [Multi-Receiver] Ready 카운트다운 이벤트
    let countdownInterval: ReturnType<typeof setInterval> | null = null;

    swarmManager.on(
      'ready-countdown-start',
      ({ waitTime }: { waitTime: number }) => {
        // 기존 interval 정리
        if (countdownInterval) {
          clearInterval(countdownInterval);
        }

        setReadyCountdown(waitTime / 1000);

        // 1초마다 카운트다운 감소
        countdownInterval = setInterval(() => {
          setReadyCountdown((prev: number | null) => {
            if (prev === null || prev <= 1) {
              if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
              }
              return null;
            }
            return prev - 1;
          });
        }, 1000);
      }
    );

    swarmManager.on('all-peers-ready', () => {
      setReadyCountdown(null); // 카운트다운 종료
    });

    // 🚀 [Multi-Receiver] 전송 배치 시작 이벤트
    swarmManager.on(
      'transfer-batch-start',
      ({ peerCount }: { peerCount: number }) => {
        setCurrentTransferPeerCount(peerCount);
        setStatus('TRANSFERRING');
      }
    );

    swarmManager.on('remote-processing', () => {
      setStatus('REMOTE_PROCESSING');
    });

    // 🚀 [Multi-Receiver] 피어 완료 이벤트
    swarmManager.on('peer-complete', (peerId: string) => {
      setCompletedPeers((prev: string[]) => [...prev, peerId]);
      // 완료된 피어는 readyPeers에서 제거
      setReadyPeers((prev: string[]) =>
        prev.filter((id: string) => id !== peerId)
      );
    });

    // 🚀 [Multi-Receiver] 피어 대기열 추가 이벤트
    swarmManager.on('peer-queued', ({ peerId }: { peerId: string }) => {
      setQueuedPeers((prev: string[]) => [...prev, peerId]);
    });

    // 🚀 [Multi-Receiver] 다음 전송 준비 상태
    swarmManager.on(
      'ready-for-next',
      ({ waitingCount }: { waitingCount: number }) => {
        setWaitingPeersCount(waitingCount);
        setStatus('READY_FOR_NEXT');
      }
    );

    // 🚀 [Multi-Receiver] 배치 완료 (대기 중인 피어 없음)
    swarmManager.on('batch-complete', () => {
      // 대기 중인 피어가 없으면 READY_FOR_NEXT로 전환
      setStatus('READY_FOR_NEXT');
    });

    // 🚀 [Multi-Receiver] 다음 전송 준비 중
    swarmManager.on(
      'preparing-next-transfer',
      ({ queueSize }: { queueSize: number }) => {
        setCurrentTransferPeerCount(queueSize);
        setQueuedPeers([]); // 대기열 초기화
        setStatus('TRANSFERRING');
      }
    );

    // 🚀 [Multi-Receiver] 대기열 처리 완료 이벤트
    swarmManager.on('queue-cleared', () => {
      setQueuedPeers([]); // 대기열 UI 초기화
    });

    // 🚀 [Multi-Receiver] 진행률 리셋 (새 전송 시작 시)
    swarmManager.on('progress', (data: any) => {
      // 진행률이 0으로 리셋되면 새 전송 시작
      if (data.progress === 0 && data.totalBytesSent === 0) {
        setProgressData({
          progress: 0,
          speed: 0,
          bytesTransferred: 0,
          totalBytes: data.totalBytes || 0,
        });
      } else {
        setProgressData({
          progress:
            data.progress ||
            (data.totalBytes > 0
              ? (data.totalBytesSent / data.totalBytes) * 100
              : 0),
          speed: data.speed || 0,
          bytesTransferred: data.totalBytesSent || data.bytesTransferred || 0,
          totalBytes: data.totalBytes || 0,
        });
      }
    });

    swarmManager.on('all-transfers-complete', () => {
      console.log(
        '[SenderView] 🎉 Received all-transfers-complete event, setting status to DONE'
      );
      setStatus('DONE');
    });

    swarmManager.on('complete', () => {
      console.log(
        '[SenderView] 🎉 Received complete event, setting status to DONE'
      );
      setStatus('DONE');
    });

    return () => {
      swarmManager.cleanup();
      swarmManager.removeAllListeners();
    };
  }, []);

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

    // Manifest 생성
    const { manifest, files } = createManifest(scannedFiles);
    setManifest(manifest);

    console.log('[SenderView] 📊 [DEBUG] Manifest created:', {
      isFolder: manifest.isFolder,
      totalFiles: manifest.totalFiles,
      totalSize: manifest.totalSize,
      rootName: manifest.rootName,
    });

    // 여러 파일이면 ZIP 압축 준비 중 표시
    if (files.length > 1) {
      setStatus('PREPARING');
    } else {
      setStatus('WAITING');
    }

    const id = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomId(id);
    setShareLink(`${window.location.origin}/receive/${id}`);

    console.log('[SenderView] 🏠 [DEBUG] Room created:', id);

    try {
      console.log('[SenderView] 🚀 [DEBUG] Initializing SwarmManager...');
      await swarmManagerRef.current?.initSender(manifest, files, id);
      console.log(
        '[SenderView] ✅ [DEBUG] SwarmManager initialized successfully'
      );

      // 초기화 완료 후 WAITING 상태로 전환
      setStatus('WAITING');
    } catch (error: any) {
      console.error('[SenderView] ❌ [DEBUG] Init failed:', error);

      alert(
        `Failed to initialize transfer: ${error?.message || 'Unknown error'}\n\nPlease try again with different files.`
      );
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
              {...({ webkitdirectory: '' } as any)}
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
                <FilePlus className="w-6 h-6 text-cyan-400 group-hover:scale-110 transition-transform" />
                <span className="font-bold">Select Files</span>
              </button>

              <button
                onClick={() => folderInputRef.current?.click()}
                className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-white py-4 rounded-xl flex flex-col items-center gap-2 transition-all group"
              >
                <Folder className="w-6 h-6 text-yellow-400 group-hover:scale-110 transition-transform" />
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

          <h2 className="text-2xl font-bold text-white mb-2">
            Preparing Files...
          </h2>
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
          <h3 className="text-xl mb-4 font-bold tracking-widest text-cyan-400">
            READY TO WARP
          </h3>
          <div className="bg-white p-4 rounded-xl mb-6 shadow-[0_0_20px_rgba(6,182,212,0.3)]">
            <QRCodeSVG value={shareLink} size={180} />
          </div>
          <p className="text-3xl font-mono font-bold mb-4 tracking-widest">
            {roomId}
          </p>

          {/* 🚀 [Multi-Receiver] 피어 상태 표시 */}
          <div className="w-full bg-gray-900/50 p-3 rounded-lg mb-4 border border-gray-700">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-cyan-400" />
                <span className="text-sm text-gray-300">Receivers</span>
              </div>
              <div className="flex items-center gap-1">
                {[...Array(MAX_DIRECT_PEERS)].map((_, i) => (
                  <div
                    key={i}
                    className={`w-3 h-3 rounded-full transition-colors ${
                      i < connectedPeers.length
                        ? readyPeers.length > i
                          ? 'bg-green-500'
                          : 'bg-cyan-500'
                        : 'bg-gray-700'
                    }`}
                  />
                ))}
                <span className="ml-2 text-sm font-mono text-gray-400">
                  {connectedPeers.length}/{MAX_DIRECT_PEERS}
                </span>
              </div>
            </div>
          </div>

          <div className="w-full bg-gray-900/50 p-4 rounded-lg mb-4 text-left border border-gray-700">
            <div className="flex items-center gap-3 mb-2">
              {manifest?.isFolder ? (
                <Folder className="text-yellow-500" />
              ) : (
                <FileIcon className="text-blue-500" />
              )}
              <span className="font-bold truncate text-lg">
                {manifest?.rootName}
              </span>
            </div>
            <p className="text-xs text-gray-400 pl-9">
              {manifest?.totalFiles} files •{' '}
              {formatBytes(manifest?.totalSize || 0)}
            </p>
          </div>

          <div className="flex gap-2 w-full">
            <div className="flex-1 bg-gray-800 rounded px-3 py-2 text-xs text-gray-400 truncate leading-8 font-mono">
              {shareLink}
            </div>
            <button
              onClick={copyToClipboard}
              className="bg-cyan-600 hover:bg-cyan-500 text-white p-2 rounded transition-colors"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>

          <div className="mt-6 text-center">
            {readyCountdown !== null ? (
              <div className="space-y-2">
                <p className="text-yellow-400 font-bold animate-pulse">
                  Starting in {readyCountdown}s...
                </p>
                <p className="text-xs text-gray-500">
                  {readyPeers.length} receiver(s) ready. Others can still join.
                </p>
              </div>
            ) : (
              <p className="text-sm text-gray-500 flex items-center justify-center gap-2">
                <Loader2 className="animate-spin w-4 h-4" />
                {connectedPeers.length === 0
                  ? 'Waiting for receivers...'
                  : `${readyPeers.length}/${connectedPeers.length} receivers ready`}
              </p>
            )}
          </div>
        </motion.div>
      )}

      {(status === 'TRANSFERRING' || status === 'CONNECTING') && (
        <div className="w-full space-y-6 max-w-lg">
          <div className="text-center">
            <h2 className="text-2xl font-bold mb-2 animate-pulse">
              Warping Data...
            </h2>
            <p className="text-cyan-400 text-2xl font-mono">
              {progressData.progress.toFixed(1)}%
            </p>
          </div>

          {/* 🚀 [Multi-Receiver] 피어 상태 표시 */}
          <div className="flex justify-center gap-2 mb-4">
            <div className="flex items-center gap-2 bg-gray-900/50 px-4 py-2 rounded-full border border-gray-700">
              <Users className="w-4 h-4 text-cyan-400" />
              <span className="text-sm text-gray-300">
                Sending to {currentTransferPeerCount || readyPeers.length}{' '}
                receiver
                {(currentTransferPeerCount || readyPeers.length) !== 1
                  ? 's'
                  : ''}
              </span>
            </div>
            {queuedPeers.length > 0 && (
              <div className="flex items-center gap-2 bg-yellow-900/30 px-4 py-2 rounded-full border border-yellow-700">
                <span className="text-sm text-yellow-300">
                  {queuedPeers.length} in queue
                </span>
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
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                Speed
              </p>
              <p className="font-mono font-bold text-cyan-300">
                {formatBytes(progressData.speed)}/s
              </p>
            </div>
            <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                Sent
              </p>
              <p className="font-mono text-gray-300">
                {formatBytes(progressData.bytesTransferred)}
              </p>
            </div>
            <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                Total
              </p>
              <p className="font-mono text-gray-300">
                {formatBytes(progressData.totalBytes)}
              </p>
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

          <h2 className="text-2xl font-bold text-white mb-2">
            Sending Completed...
          </h2>
          <h3 className="text-xl text-yellow-400 font-bold mb-6 animate-pulse">
            Waiting for Receivers to Save
          </h3>

          <div className="bg-black/40 p-4 rounded-xl text-left flex gap-3 border border-yellow-500/20">
            <AlertTriangle className="w-6 h-6 text-yellow-500 flex-shrink-0" />
            <div className="text-sm text-gray-300">
              <p className="font-bold text-white mb-1">
                Do NOT close this window.
              </p>
              <p>
                The receivers are currently saving the files. The connection
                must remain open until they finish downloading.
              </p>
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

          <h2 className="text-2xl font-bold text-white mb-2">
            Transfer Batch Complete
          </h2>
          <p className="text-gray-400 mb-4">
            {completedPeers.length} receiver(s) have successfully downloaded the
            files.
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
                <div
                  key={peerId}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-gray-400">Receiver {i + 1}</span>
                  <span
                    className={`px-2 py-1 rounded text-xs ${
                      completedPeers.includes(peerId)
                        ? 'bg-green-900/50 text-green-400'
                        : queuedPeers.includes(peerId)
                          ? 'bg-yellow-900/50 text-yellow-400'
                          : 'bg-gray-800 text-gray-400'
                    }`}
                  >
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
                <p className="font-bold text-white mb-1">
                  Waiting for {waitingPeersCount} more receiver(s)
                </p>
                <p>
                  Keep this window open. Transfer will start automatically when
                  they click "Start Download".
                </p>
              </div>
            </div>
          ) : (
            <div className="bg-black/40 p-4 rounded-xl text-left flex gap-3 border border-gray-700 mb-4">
              <AlertTriangle className="w-6 h-6 text-gray-500 flex-shrink-0" />
              <div className="text-sm text-gray-300">
                <p className="font-bold text-white mb-1">
                  No more receivers waiting
                </p>
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
              ? `All ${connectedPeers.length} receivers have successfully saved the files.`
              : 'The receiver has successfully saved the files.'}
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
