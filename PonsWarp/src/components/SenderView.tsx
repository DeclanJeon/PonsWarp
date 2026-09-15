import { debugLog } from '../utils/logger';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Upload,
  Folder,
  File as FileIcon,
  CheckCircle,
  Check,
  Loader2,
  FilePlus,
  AlertTriangle,
  Users,
} from 'lucide-react';
import { SwarmManager } from '../services/swarmManager';
import { lanEvidenceAdapter } from '../services/lanEvidenceAdapter';
import { createManifestProgressive, formatBytes } from '../utils/fileUtils';
import {
  scanFiles,
  processInputFiles,
  snapshotFileListProgressive,
  ScannedFile,
  FileScanProgress,
} from '../utils/fileScanner';
import { motion, AnimatePresence } from 'framer-motion';
import { useTransferStore } from '../store/transferStore';
import { TransferManifest, AppMode } from '../types/types';
import { getErrorMessage } from '../utils/errors';
import {
  estimateRemainingSeconds,
  formatRemainingTime,
  getTransferFeedbackLabel,
} from '../utils/transferEstimate';
import { formatSlowPathBanner } from '../services/hybridBulkTransport';
import { toast } from '../store/toastStore';

interface SenderViewProps {
  onComplete?: () => void;
}

type DirectoryInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  webkitdirectory: string;
};

type SenderProgressPayload = {
  progress?: number;
  speed?: number;
  totalBytesSent?: number;
  bytesTransferred?: number;
  totalBytes?: number;
  candidatePathKind?: string;
  hostAddressScope?: string | null;
  protocol?: string | null;
  relayProtocol?: string | null;
  rttMs?: number | null;
};

const directoryInputProps: DirectoryInputProps = { webkitdirectory: '' };

const SenderView: React.FC<SenderViewProps> = () => {
  type SenderStatus =
    | 'IDLE'
    | 'SCANNING'
    | 'WAITING'
    | 'CONNECTING'
    | 'TRANSFERRING'
    | 'REMOTE_PROCESSING'
    | 'READY_FOR_NEXT'
    | 'DONE'
    | 'ERROR';
  const [manifest, setManifest] = useState<TransferManifest | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<SenderStatus>('IDLE');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isOpeningRoom, setIsOpeningRoom] = useState(false);
  const [scanProgress, setScanProgress] = useState<FileScanProgress | null>(
    null
  );
  const setTransferStatus = useCallback(
    (next: SenderStatus | ((prev: SenderStatus) => SenderStatus)) => {
      setStatus(prev => {
        if (prev === 'DONE') return prev;
        const resolved = typeof next === 'function' ? next(prev) : next;
        // Keep global store in sync so navigation guards know a session is live.
        useTransferStore.setState({ status: resolved as any });
        return resolved;
      });
    },
    []
  );

  useEffect(() => {
    useTransferStore.setState({ mode: AppMode.SENDER });
    return () => {
      // Only clear if still on sender status and not actively receiving elsewhere.
      const current = useTransferStore.getState();
      if (
        current.mode === AppMode.SENDER &&
        current.status !== 'TRANSFERRING'
      ) {
        // leave mode as-is; App owns mode transitions
      }
    };
  }, []);
  const [progressData, setProgressData] = useState({
    progress: 0,
    speed: 0,
    bytesTransferred: 0,
    totalBytes: 0,
    pathKind: 'unknown' as string,
    hostAddressScope: null as string | null,
    protocol: null as string | null,
    rttMs: null as number | null,
  });
  const estimatedSecondsRemaining = estimateRemainingSeconds(
    progressData.bytesTransferred,
    progressData.totalBytes,
    progressData.speed
  );
  const transferFeedbackLabel = getTransferFeedbackLabel(
    progressData.bytesTransferred,
    progressData.totalBytes,
    progressData.speed
  );

  // 🚀 [1:1] 연결된 수신자 추적 (단일 피어)
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [readyPeers, setReadyPeers] = useState<string[]>([]);
  const [readyCountdown, setReadyCountdown] = useState<number | null>(null);

  // SwarmManager 인스턴스
  const swarmManagerRef = useRef<SwarmManager | null>(null);

  // Input Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // SwarmManager 인스턴스 생성
    const swarmManager = new SwarmManager();
    swarmManagerRef.current = swarmManager;
    let stopEvidenceCommands: (() => void) | undefined;
    if (lanEvidenceAdapter.enabled) {
      void (async () => {
        try {
          await lanEvidenceAdapter.hello();
          swarmManager.armTransferStartGate();
          stopEvidenceCommands = lanEvidenceAdapter.onCommand(command => {
            if (command.type !== 'START') return;
            void (async () => {
              try {
                const payload = (command.payload || {}) as Record<
                  string,
                  unknown
                >;
                const pipelineOn =
                  payload.pipelineOn === true || payload.control === 'on';
                if (pipelineOn) {
                  const certificateId = String(payload.certificateId || '');
                  const certificateDigest = String(
                    payload.certificateDigest || ''
                  );
                  const armDigest = String(payload.armDigest || '');
                  const certificateExpiresAtMs = Number(
                    payload.certificateExpiresAtMs
                  );
                  const generation = swarmManager.getTransferGeneration();
                  if (
                    !certificateId ||
                    !certificateDigest ||
                    !armDigest ||
                    !Number.isFinite(certificateExpiresAtMs) ||
                    !swarmManager.setPipelineCertificateBinding({
                      generation,
                      runId: generation,
                      certificateId,
                      certificateDigest,
                      armDigest,
                      expiresAtMs: certificateExpiresAtMs,
                    })
                  )
                    throw new Error('Evidence pipeline certificate rejected');
                } else {
                  swarmManager.clearPipelineCertificateBinding();
                }
                if (!swarmManager.releaseTransferStartGate())
                  throw new Error('Evidence START release rejected');
                await lanEvidenceAdapter.reportPhase('STARTED', { pipelineOn });
              } catch (error) {
                swarmManager.disableLanHostPipelineForActiveRun(
                  'evidence-start-rejected'
                );
                swarmManager.clearPipelineCertificateBinding();
                await lanEvidenceAdapter
                  .report('ERROR', { message: String(error) })
                  .catch(() => undefined);
              }
            })();
          });
          await lanEvidenceAdapter.listen(() => undefined);
        } catch (error) {
          await lanEvidenceAdapter
            .report('ERROR', { message: String(error) })
            .catch(() => undefined);
        }
      })();
    }
    const completionPoll = setInterval(() => {
      if (swarmManager.isSessionComplete()) {
        setTransferStatus('DONE');
      }
    }, 500);

    // 이벤트 핸들러 등록
    swarmManager.on('status', (s: string) => {
      setTransferStatus(prev => {
        if (prev === 'DONE') return prev;
        if (s === 'WAITING_FOR_PEER') {
          return prev === 'IDLE' || prev === 'WAITING' ? 'WAITING' : prev;
        }
        if (s === 'CONNECTING') {
          return prev === 'IDLE' || prev === 'WAITING' ? 'CONNECTING' : prev;
        }
        if (s === 'TRANSFERRING') return 'TRANSFERRING';
        return prev;
      });
    });

    swarmManager.on('error', (errorMsg: string) => {
      console.error('[SenderView] SwarmManager error:', errorMsg);
      toast.error(`Transfer error: ${errorMsg}. Please try again.`);
      setTransferStatus('IDLE');
    });

    // Pre-flight NAT probe: warn early when a relay path is likely.
    swarmManager.on('nat-probe', (result: { verdict: string }) => {
      if (result.verdict === 'relay-likely' || result.verdict === 'blocked') {
        toast.warning(
          'This network may require a relay — transfers can be slower but will still work.'
        );
      }
    });

    // 🚀 [1:1] 피어 이벤트 (단일 수신자)
    swarmManager.on('peer-connected', (peerId: string) => {
      setConnectedPeers((prev: string[]) => [...prev, peerId]);
    });

    swarmManager.on(
      'peer-disconnected',
      ({ peerId }: { peerId: string; reason?: string }) => {
        setConnectedPeers((prev: string[]) =>
          prev.filter((id: string) => id !== peerId)
        );
        setReadyPeers((prev: string[]) =>
          prev.filter((id: string) => id !== peerId)
        );

        // 전송 중 수신자 이탈 → WARPING DATA에 갇히지 않고 ERROR로 전환.
        // 수신자가 재연결해 resume되면 'TRANSFERRING' 상태 이벤트가 복구한다.
        const current = useTransferStore.getState().status;
        if (current === 'TRANSFERRING' || current === 'REMOTE_PROCESSING') {
          setErrorMessage('Transfer failed: peer disconnected');
          setTransferStatus('ERROR');
          toast.error('Transfer failed: peer disconnected');
        }
      }
    );

    swarmManager.on('peer-ready', (peerId: string) => {
      setReadyPeers((prev: string[]) => [...prev, peerId]);
    });

    // Ready 카운트다운 이벤트
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

    // 전송 시작 이벤트
    swarmManager.on(
      'transfer-batch-start',
      ({ peerCount: _peerCount }: { peerCount: number }) => {
        setTransferStatus('TRANSFERRING');
      }
    );

    swarmManager.on('remote-processing', () => {
      setTransferStatus('REMOTE_PROCESSING');
    });

    // 전송 실패 (모든 피어 이탈, resume offset 오류, reader stall 등)
    swarmManager.on('transfer-failed', (msg: unknown) => {
      const message = `Transfer failed: ${
        typeof msg === 'string' && msg ? msg : 'peer disconnected'
      }`;
      setErrorMessage(message);
      setTransferStatus('ERROR');
      toast.error(message);
    });

    // 진행률 리셋 (새 전송 시작 시)
    swarmManager.on('progress', (data: SenderProgressPayload) => {
      const pathMeta = {
        pathKind: data.candidatePathKind || 'unknown',
        hostAddressScope:
          typeof data.hostAddressScope === 'string'
            ? data.hostAddressScope
            : null,
        protocol: data.protocol ?? null,
        rttMs: typeof data.rttMs === 'number' ? data.rttMs : null,
      };
      // 진행률이 0으로 리셋되면 새 전송 시작
      if (data.progress === 0 && data.totalBytesSent === 0) {
        setProgressData({
          progress: 0,
          speed: 0,
          bytesTransferred: 0,
          totalBytes: data.totalBytes || 0,
          ...pathMeta,
        });
      } else {
        setProgressData({
          progress:
            data.progress ||
            (data.totalBytes > 0
              ? ((data.totalBytesSent || 0) / data.totalBytes) * 100
              : 0),
          speed: data.speed || 0,
          bytesTransferred: data.totalBytesSent || data.bytesTransferred || 0,
          totalBytes: data.totalBytes || 0,
          ...pathMeta,
        });
      }
    });

    swarmManager.on('all-transfers-complete', () => {
      debugLog(
        '[SenderView] 🎉 Received all-transfers-complete event, setting status to DONE'
      );
      setTransferStatus('DONE');
    });

    swarmManager.on('complete', () => {
      debugLog(
        '[SenderView] 🎉 Received complete event, setting status to DONE'
      );
      setTransferStatus('DONE');
    });

    return () => {
      if (lanEvidenceAdapter.enabled) {
        stopEvidenceCommands?.();
        swarmManager.disableLanHostPipelineForActiveRun('evidence-cleanup');
        swarmManager.clearPipelineCertificateBinding();
        void lanEvidenceAdapter.release();
      }
      clearInterval(completionPoll);
      swarmManager.cleanup();
      swarmManager.removeAllListeners();
    };
  }, [setTransferStatus]);

  const handleScanProgress = useCallback((progress: FileScanProgress) => {
    // Throttle React updates on multi-thousand mobile selections.
    setScanProgress(prev => {
      if (
        prev &&
        progress.phase === 'listing' &&
        progress.scannedFiles - (prev.scannedFiles || 0) < 64 &&
        progress.totalHint === prev.totalHint
      ) {
        return prev;
      }
      return progress;
    });
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Progressive snapshot first: input.value = '' clears the live FileList.
    const live = e.target.files;
    const totalHint = live?.length ?? 0;
    if (!live || totalHint === 0) {
      e.target.value = '';
      return;
    }
    setScanProgress({
      scannedFiles: 0,
      totalHint,
      phase: 'listing',
    });
    setTransferStatus('SCANNING');
    try {
      const fileList = await snapshotFileListProgressive(live, {
        onProgress: progress => {
          // During snapshot we only know totalHint; keep UI alive.
          setScanProgress(prev => ({
            scannedFiles: prev?.scannedFiles ?? 0,
            totalHint: progress.totalHint ?? totalHint,
            phase: 'listing',
          }));
        },
      });
      e.target.value = '';
      if (fileList.length === 0) {
        setScanProgress(null);
        setTransferStatus('IDLE');
        return;
      }
      const scannedFiles = await processInputFiles(fileList, {
        onProgress: handleScanProgress,
      });
      await processScannedFiles(scannedFiles);
    } catch (error) {
      e.target.value = '';
      if ((error as DOMException)?.name === 'AbortError') return;
      console.error('[SenderView] file scan failed:', error);
      setScanProgress(null);
      setTransferStatus('IDLE');
      toast.error(
        `Failed to load files: ${getErrorMessage(error, 'Unknown error')}`
      );
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
    // Do not force IDLE if a transfer/scan session already started.
    const current = useTransferStore.getState();
    if (current.status === 'DRAGGING_FILES') {
      useTransferStore.setState({ status: 'IDLE' });
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setScanProgress({ scannedFiles: 0, phase: 'listing' });
    setTransferStatus('SCANNING');

    try {
      // Prefer FileSystemEntry scan for folder structure.
      if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        const scannedFiles = await scanFiles(e.dataTransfer.items, {
          onProgress: handleScanProgress,
        });
        await processScannedFiles(scannedFiles);
      } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const dropped = await snapshotFileListProgressive(
          e.dataTransfer.files,
          {
            onProgress: handleScanProgress,
          }
        );
        const scannedFiles = await processInputFiles(dropped, {
          onProgress: handleScanProgress,
        });
        await processScannedFiles(scannedFiles);
      } else {
        setScanProgress(null);
        setTransferStatus('IDLE');
      }
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') return;
      console.error('[SenderView] drop scan failed:', error);
      setScanProgress(null);
      setTransferStatus('IDLE');
      toast.error(
        `Failed to load files: ${getErrorMessage(error, 'Unknown error')}`
      );
    }
  };

  const processScannedFiles = async (scannedFiles: ScannedFile[]) => {
    if (scannedFiles.length === 0) {
      setScanProgress(null);
      setTransferStatus('IDLE');
      toast.error('No transferable files found (empty or filtered selection).');
      return;
    }

    setScanProgress(prev =>
      prev
        ? { ...prev, scannedFiles: scannedFiles.length, phase: 'done' }
        : { scannedFiles: scannedFiles.length, phase: 'done' }
    );

    // Progressive manifest build keeps large mobile selections off the long-task path.
    const { manifest, files } = await createManifestProgressive(scannedFiles, {
      onProgress: (built, total) => {
        setScanProgress({
          scannedFiles: built,
          totalHint: total,
          phase: built >= total ? 'done' : 'listing',
        });
      },
    });
    setManifest(manifest);

    debugLog('[SenderView] 📊 [DEBUG] Manifest created:', {
      isFolder: manifest.isFolder,
      totalFiles: manifest.totalFiles,
      totalSize: manifest.totalSize,
      rootName: manifest.rootName,
    });

    const id = Math.random().toString(36).substring(2, 8).toUpperCase();
    setRoomId(id);
    setShareLink(`${window.location.origin}/receive/${id}`);
    setIsOpeningRoom(true);
    // Room code/QR must appear immediately for multi-file mobile sends.
    // ZIP/encryption preparation starts only after a receiver accepts, so
    // holding users on PREPARING while signaling initializes is misleading.
    setTransferStatus('WAITING');

    debugLog('[SenderView] 🏠 [DEBUG] Room created:', id);

    try {
      debugLog('[SenderView] 🚀 [DEBUG] Initializing SwarmManager...');
      await swarmManagerRef.current?.initSender(manifest, files, id);
      debugLog('[SenderView] ✅ [DEBUG] SwarmManager initialized successfully');
      await lanEvidenceAdapter.reportPhase('READY', {
        transferId: manifest.transferId,
        totalBytes: manifest.totalSize,
        roomId: id,
      });
      await lanEvidenceAdapter.reportPhase('ROOM_READY', {
        transferId: manifest.transferId,
        roomId: id,
      });

      setIsOpeningRoom(false);
      // 초기화 완료 후에도 이미 전송/완료 이벤트가 들어왔다면 상태를 되돌리지 않는다.
      setTransferStatus(prev => (prev === 'IDLE' ? 'WAITING' : prev));
    } catch (error) {
      console.error('[SenderView] ❌ [DEBUG] Init failed:', error);

      toast.error(
        `Failed to initialize transfer: ${getErrorMessage(error, 'Unknown error')}. Please try again with different files.`
      );
      setIsOpeningRoom(false);
      setRoomId(null);
      setShareLink(null);
      setTransferStatus('IDLE');
    }
  };

  const copyToClipboard = async () => {
    if (shareLink) {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // 공통 Glass Panel 스타일 (통일성 유지)
  const glassPanelClass =
    'bg-black/40 backdrop-blur-2xl border border-cyan-500/20 rounded-[2rem] shadow-[0_0_40px_rgba(0,0,0,0.3)]';

  return (
    <div className="relative z-10 flex min-h-full w-full flex-col items-center justify-start px-1 pb-4 pt-0 sm:px-3 md:justify-center md:px-0 md:py-4">
      <AnimatePresence>
        {/* --- STATE: SCANNING (bulk metadata listing) --- */}
        {status === 'SCANNING' && (
          <motion.div
            key="scanning"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className={`w-full max-w-md p-8 flex flex-col items-center text-center ${glassPanelClass}`}
          >
            <Loader2 className="w-12 h-12 text-cyan-400 animate-spin mb-5" />
            <h2 className="text-2xl font-bold brand-font text-white mb-2">
              LOADING FILES
            </h2>
            <p className="text-cyan-100/70 font-mono text-sm mb-4">
              Building file list without freezing the UI
            </p>
            <p className="text-4xl font-mono font-black text-cyan-300">
              {scanProgress?.scannedFiles ?? 0}
              {typeof scanProgress?.totalHint === 'number' &&
              scanProgress.totalHint > 0 ? (
                <span className="text-lg text-gray-500">
                  {' '}
                  / {scanProgress.totalHint}
                </span>
              ) : null}
            </p>
            <p className="mt-2 text-xs text-gray-500 font-mono tracking-wide">
              files prepared
            </p>
          </motion.div>
        )}

        {/* --- STATE: IDLE (File Selection) --- */}
        {status === 'IDLE' && (
          <motion.div
            key="idle"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20, filter: 'blur(10px)' }}
            className={`w-full max-w-2xl overflow-hidden p-2 ${glassPanelClass}`}
          >
            {/* Drag & Drop Zone (Focal Point) */}
            <div
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className="border-2 border-dashed border-cyan-500/30 rounded-[1.8rem] py-8 px-4 md:py-16 md:px-10 flex flex-col items-center justify-center text-center transition-all hover:border-cyan-400/60 hover:bg-cyan-500/5"
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
                {...directoryInputProps}
              />

              <div className="w-16 h-16 md:w-20 md:h-20 bg-cyan-900/20 rounded-full flex items-center justify-center mb-6 md:mb-8 shadow-[0_0_30px_rgba(6,182,212,0.2)] group-hover:scale-110 transition-transform duration-300">
                <Upload className="w-8 h-8 md:w-10 md:h-10 text-cyan-400 animate-pulse" />
              </div>

              <h2 className="text-2xl md:text-3xl font-bold mb-3 md:mb-4 brand-font text-white">
                DROP FILES
              </h2>
              <p className="text-cyan-100/60 text-sm md:text-lg mb-6 md:mb-8 font-rajdhani tracking-wide">
                or select from device
              </p>

              {/* 버튼 세로 배치(모바일) -> 가로 배치(태블릿 이상) 유지하되 크기 조절 */}
              <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 bg-gray-800/80 hover:bg-gray-700 border border-gray-600 hover:border-cyan-500 text-white py-3 md:py-4 px-4 rounded-xl flex items-center justify-center gap-2 transition-all group/btn shadow-lg"
                >
                  <FilePlus className="w-4 h-4 md:w-5 md:h-5 text-cyan-400 group-hover/btn:scale-110 transition-transform" />
                  <span className="font-bold tracking-wider text-sm md:text-base">
                    FILES
                  </span>
                </button>

                <button
                  onClick={() => folderInputRef.current?.click()}
                  className="flex-1 bg-gray-800/80 hover:bg-gray-700 border border-gray-600 hover:border-yellow-500 text-white py-3 md:py-4 px-4 rounded-xl flex items-center justify-center gap-2 transition-all group/btn shadow-lg"
                >
                  <Folder className="w-4 h-4 md:w-5 md:h-5 text-yellow-400 group-hover/btn:scale-110 transition-transform" />
                  <span className="font-bold tracking-wider text-sm md:text-base">
                    FOLDER
                  </span>
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {/* --- STATE: WAITING (QR & Room ID) --- */}
        {status === 'WAITING' && roomId && shareLink && (
          <motion.div
            key="waiting"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`w-full max-w-sm p-3 sm:p-5 md:p-8 flex flex-col items-center ${glassPanelClass}`}
          >
            {/* Status Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 mb-3 md:mb-8">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500"></span>
              </span>
              <span className="text-xs font-bold text-cyan-300 tracking-[0.2em]">
                WARP GATE OPEN
              </span>
            </div>

            {/* QR Code */}
            <div
              className="bg-white p-3 md:p-4 rounded-2xl mb-3 md:mb-8 shadow-[0_0_40px_rgba(6,182,212,0.25)] cursor-pointer"
              onClick={copyToClipboard}
            >
              <QRCodeSVG
                value={shareLink}
                size={180}
                className="h-[104px] w-[104px] sm:h-[140px] sm:w-[140px] md:h-[180px] md:w-[180px]"
              />
            </div>

            {/* Room ID Display */}
            <div
              className="text-center mb-3 md:mb-8 w-full group cursor-pointer"
              onClick={copyToClipboard}
            >
              <p className="text-gray-500 text-[10px] tracking-[0.3em] uppercase mb-2">
                Warp Key
              </p>
              <div className="relative">
                <p className="text-3xl sm:text-4xl md:text-6xl font-mono font-bold tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-white to-cyan-400 bg-300% animate-shine group-hover:scale-105 transition-transform">
                  {roomId}
                </p>
                {copied && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="absolute -right-8 top-1/2 -translate-y-1/2 text-green-400"
                  >
                    <Check size={24} />
                  </motion.div>
                )}
              </div>
            </div>

            {/* 연결 상태 표시 (1:1) */}
            <div className="w-full bg-gray-900/40 p-3 md:p-4 rounded-xl mb-2 md:mb-4 border border-gray-700/50 backdrop-blur-sm">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-sm text-gray-300">
                  <Users size={14} className="text-cyan-400" />
                  <span>Receiver</span>
                </div>
                <span className="text-xs font-mono text-gray-500">
                  {connectedPeers.length > 0
                    ? readyPeers.length > 0
                      ? 'READY'
                      : 'CONNECTED'
                    : 'WAITING'}
                </span>
              </div>
              <div className="flex gap-2">
                {[...Array(1)].map((_, i) => (
                  <div
                    key={i}
                    className={`h-1.5 flex-1 rounded-full transition-all duration-500 ${
                      connectedPeers.length > 0
                        ? readyPeers.length > 0
                          ? 'bg-green-500 shadow-[0_0_10px_#22c55e]'
                          : 'bg-cyan-500 shadow-[0_0_10px_#06b6d4]'
                        : 'bg-gray-800'
                    }`}
                  />
                ))}
              </div>
            </div>

            {/* File Info Card (Left Aligned for Readability - 7.webp) */}
            <div className="w-full bg-gray-800/30 p-3 md:p-4 rounded-xl border border-gray-700/50 flex items-center gap-3 md:gap-4 text-left">
              <div className="w-10 h-10 rounded-lg bg-gray-700/50 flex items-center justify-center flex-shrink-0">
                {manifest?.isFolder ? (
                  <Folder className="text-yellow-400 w-5 h-5" />
                ) : (
                  <FileIcon className="text-blue-400 w-5 h-5" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-white text-sm truncate">
                  {manifest?.rootName}
                </p>
                <p className="text-xs text-gray-400 font-mono mt-0.5">
                  {manifest?.totalFiles} files •{' '}
                  {formatBytes(manifest?.totalSize || 0)}
                </p>
              </div>
            </div>

            {/* Waiting Message / Countdown */}
            <div className="mt-3 md:mt-6 text-center h-6">
              {readyCountdown !== null ? (
                <p className="text-yellow-400 text-sm font-bold animate-pulse tracking-wide">
                  Auto-starting in {readyCountdown}s...
                </p>
              ) : (
                <p className="text-xs text-gray-500 font-mono">
                  {isOpeningRoom
                    ? 'Opening secure room...'
                    : connectedPeers.length === 0
                      ? 'Waiting for connection...'
                      : 'Waiting for receiver to accept...'}
                </p>
              )}
            </div>
          </motion.div>
        )}

        {/* --- STATE: TRANSFERRING (Progress Bar) --- */}
        {(status === 'TRANSFERRING' || status === 'CONNECTING') && (
          <motion.div
            key="transferring"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-xl space-y-5 px-1 sm:space-y-8 sm:px-0"
          >
            {/* Header */}
            <div className="text-center">
              <h2 className="mb-2 animate-pulse brand-font text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-purple-400 sm:text-3xl">
                WARPING DATA...
              </h2>
              <p className="font-mono text-5xl font-black text-white drop-shadow-[0_0_20px_rgba(6,182,212,0.5)] sm:text-6xl">
                {progressData.progress.toFixed(1)}
                <span className="text-xl text-gray-500 sm:text-2xl">%</span>
              </p>
              <p className="mt-3 px-2 text-xs text-cyan-100/70 font-mono break-words sm:text-sm">
                {transferFeedbackLabel}
              </p>
            </div>

            {/* 수신자 상태 배지 (1:1) */}
            <div className="flex flex-wrap justify-center gap-2 sm:gap-3">
              <div className="flex items-center gap-2 bg-gray-900/60 px-4 py-2 rounded-full border border-gray-700 backdrop-blur-sm">
                <Users size={14} className="text-cyan-400" />
                <span className="text-xs text-gray-300 font-mono">
                  Sending to 1 peer
                </span>
              </div>
            </div>

            {/* Progress Bar (Visual) */}
            <div className="relative h-6 bg-gray-900/50 rounded-full overflow-hidden border border-gray-700 shadow-inner">
              <motion.div
                className="absolute top-0 left-0 h-full bg-gradient-to-r from-cyan-500 via-blue-500 to-purple-600"
                initial={{ width: 0 }}
                animate={{ width: `${progressData.progress}%` }}
                transition={{ type: 'spring', stiffness: 50, damping: 15 }}
              />
              {/* Shine effect on bar */}
              <div className="absolute top-0 left-0 w-full h-full bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent)] bg-[length:50%_100%] animate-shine opacity-50" />
            </div>

            {/* Stats Grid */}
            <p
              className={`-mt-1 mb-1 px-2 text-center font-mono text-[10px] leading-relaxed break-words sm:text-[11px] ${
                progressData.pathKind === 'relay'
                  ? 'text-amber-300'
                  : progressData.pathKind === 'host'
                    ? 'text-emerald-300'
                    : 'text-cyan-200/70'
              }`}
            >
              {formatSlowPathBanner({
                pathKind: progressData.pathKind,
                protocol: progressData.protocol,
                hostAddressScope: progressData.hostAddressScope,
                rttMs: progressData.rttMs,
              })}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-4 md:gap-4">
              <div className="bg-black/30 backdrop-blur-md p-3 md:p-4 rounded-2xl border border-white/5 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                  Speed
                </p>
                <p className="font-mono font-bold text-cyan-300 text-base md:text-lg">
                  {formatBytes(progressData.speed)}/s
                </p>
              </div>
              <div className="bg-black/30 backdrop-blur-md p-3 md:p-4 rounded-2xl border border-white/5 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                  Sent
                </p>
                <p className="font-mono text-white text-base md:text-lg">
                  {formatBytes(progressData.bytesTransferred)}
                </p>
              </div>
              <div className="bg-black/30 backdrop-blur-md p-3 md:p-4 rounded-2xl border border-white/5 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                  Time Left
                </p>
                <p className="font-mono text-white text-base md:text-lg">
                  {formatRemainingTime(estimatedSecondsRemaining)}
                </p>
              </div>
              <div className="bg-black/30 backdrop-blur-md p-3 md:p-4 rounded-2xl border border-white/5 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                  Total
                </p>
                <p className="font-mono text-gray-400 text-base md:text-lg">
                  {formatBytes(progressData.totalBytes)}
                </p>
              </div>
            </div>
          </motion.div>
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

        {/* 전송 완료 (1:1) */}
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
              Transfer Complete
            </h2>
            <p className="text-gray-400 mb-4">
              The receiver has successfully downloaded the files.
            </p>

            <div className="bg-black/40 p-4 rounded-xl text-left flex gap-3 border border-gray-700 mb-4">
              <AlertTriangle className="w-6 h-6 text-gray-500 flex-shrink-0" />
              <div className="text-sm text-gray-300">
                <p className="font-bold text-white mb-1">
                  No more receivers waiting
                </p>
                <p>You can send another file or close this window.</p>
              </div>
            </div>

            <button
              onClick={() => window.location.reload()}
              className="bg-white text-black px-8 py-3 rounded-full font-bold hover:bg-cyan-50 transition-colors"
            >
              Send New Files
            </button>
          </motion.div>
        )}

        {/* --- STATE: ERROR --- */}
        {status === 'ERROR' && (
          <motion.div
            key="error"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center p-8 bg-red-900/20 rounded-3xl border border-red-500/30 max-w-lg w-full"
          >
            <div className="w-24 h-24 mx-auto mb-6 bg-red-500/20 rounded-full flex items-center justify-center shadow-[0_0_40px_rgba(239,68,68,0.4)]">
              <AlertTriangle className="w-12 h-12 text-red-400" />
            </div>
            <h2 className="text-4xl font-bold text-white mb-4 brand-font tracking-wide">
              TRANSFER FAILED
            </h2>
            <p className="text-gray-400 text-lg mb-10 max-w-md mx-auto">
              {errorMessage ?? 'Transfer failed: peer disconnected'}
            </p>

            <button
              onClick={() => window.location.reload()}
              className="bg-white/10 border border-white/20 text-white px-10 py-4 rounded-full font-bold hover:bg-white/20 transition-all flex items-center gap-3 mx-auto"
            >
              <FilePlus size={20} />
              Try Again
            </button>
          </motion.div>
        )}

        {/* --- STATE: DONE --- */}
        {status === 'DONE' && (
          <motion.div
            key="done"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center"
          >
            <div className="w-24 h-24 mx-auto mb-6 bg-green-500/20 rounded-full flex items-center justify-center shadow-[0_0_40px_rgba(34,197,94,0.4)]">
              <CheckCircle className="w-12 h-12 text-green-400" />
            </div>
            <h2 className="text-4xl font-bold text-white mb-4 brand-font tracking-wide">
              SUCCESS
            </h2>
            <p className="text-gray-400 text-lg mb-10 max-w-md mx-auto">
              Transfer completed successfully.
            </p>

            <button
              onClick={() => window.location.reload()}
              className="bg-white/10 border border-white/20 text-white px-10 py-4 rounded-full font-bold hover:bg-white/20 transition-all flex items-center gap-3 mx-auto"
            >
              <FilePlus size={20} />
              Send More Files
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default SenderView;
