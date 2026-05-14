import { debugLog } from '../utils/logger';
/* 🪲 [DEBUG] ReceiverView UI/UX 개선 시작 */
debugLog('[ReceiverView] 🪲 [DEBUG] UI/UX Enhancement Started:');
debugLog('[ReceiverView] 🪲 [DEBUG] - Applying HUD-style circular progress');
debugLog('[ReceiverView] 🪲 [DEBUG] - Implementing mobile-optimized input');
debugLog('[ReceiverView] 🪲 [DEBUG] - Adding focal point principles');

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Scan,
  Download,
  Archive,
  AlertCircle,
  CheckCircle,
  RefreshCw,
  Radio,
  File as FileIcon,
  Folder,
} from 'lucide-react';
import { transferService } from '../services/webRTCService';
import { CONNECTION_TIMEOUT_MS } from '../utils/constants';
import { DirectFileWriter } from '../services/directFileWriter';
import { formatBytes } from '../utils/fileUtils';
import { motion, AnimatePresence } from 'framer-motion';
import { useTransferStore } from '../store/transferStore';
import { TransferManifest } from '../types/types';
import { getErrorMessage, getErrorName } from '../utils/errors';
import {
  estimateRemainingSeconds,
  formatRemainingTime,
  getTransferFeedbackLabel,
} from '../utils/transferEstimate';

type ReceiverProgressPayload = {
  progress?: number;
  speed?: number;
  bytesTransferred?: number;
  totalBytes?: number;
};

type ReceiverCompletePayload = {
  actualSize?: number;
};

const ReceiverView: React.FC = () => {
  // 전역 상태 사용
  const {
    roomId,
    setRoomId,
    status,
    setStatus,
    progress,
    manifest,
    setManifest,
    updateProgress,
  } = useTransferStore();

  const [errorMsg, setErrorMsg] = useState('');
  const [actualSize, setActualSize] = useState<number>(0);
  const [progressData, setProgressData] = useState({
    progress: 0,
    speed: 0,
    bytesTransferred: 0,
    totalBytes: 0,
  });

  // 🚨 [추가] 송신자 응답 대기 상태 변수
  const [isWaitingForSender, setIsWaitingForSender] = useState(false);
  const isWaitingForSenderRef = useRef(isWaitingForSender);
  useEffect(() => {
    isWaitingForSenderRef.current = isWaitingForSender;
  }, [isWaitingForSender]);

  // 🚀 [Multi-Receiver] 대기열 상태
  const [queuePosition, setQueuePosition] = useState<number>(0);
  const [queueMessage, setQueueMessage] = useState<string>('');

  // 🚨 [추가] 연결 타임아웃 관리용 Ref
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 🚨 [핵심 수정 1] status의 최신 값을 추적하기 위한 Ref 생성
  // setTimeout과 같은 비동기 클로저 안에서도 항상 최신 상태를 읽을 수 있게 함
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // 🚀 [성능 최적화] UI 렌더링 스로틀링 (초당 10회 제한)
  const lastProgressUpdateRef = useRef<number>(0);
  const UI_UPDATE_INTERVAL = 100; // 100ms마다 한 번만 UI 업데이트

  // 🚀 [핵심] 이벤트 핸들러들을 useCallback으로 메모이제이션하여 안정성 확보
  const handleMetadata = useCallback(
    (m: TransferManifest) => {
      // 🚨 [수정] 메타데이터 수신 시 타임아웃 해제 및 에러 상태 초기화
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      setErrorMsg(''); // 이전 에러 메시지 초기화
      setManifest(m);

      // 🚀 [Multi-Receiver] QUEUED 상태에서 manifest를 다시 받으면
      // 대기열에서 전송이 시작된 것이므로 RECEIVING으로 전환
      const currentStatus = statusRef.current;
      if (currentStatus === 'QUEUED') {
        debugLog(
          '[ReceiverView] Manifest received while QUEUED - transfer starting'
        );
        setQueuePosition(0);
        setQueueMessage('');
        updateProgress({
          progress: 0,
          bytesTransferred: 0,
          totalBytes: m?.totalSize || 0,
        });
        setProgressData({
          progress: 0,
          speed: 0,
          bytesTransferred: 0,
          totalBytes: m?.totalSize || 0,
        });
        setStatus('RECEIVING');
        setIsWaitingForSender(false);
      } else if (currentStatus !== 'RECEIVING' && currentStatus !== 'DONE') {
        // 일반적인 경우: WAITING 상태로 전환
        setStatus('WAITING');
      }
    },
    [setManifest, setStatus, updateProgress]
  );

  const handleRemoteStarted = useCallback(() => {
    // 🚨 [핵심 수정] 송신자 응답 시 타임아웃 해제
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    setIsWaitingForSender(false);
  }, []);

  const handleProgress = useCallback(
    (p: ReceiverProgressPayload | number) => {
      // 1. 대기 상태 해제 (데이터가 들어오기 시작함)
      setIsWaitingForSender(false);

      // 2. 상태 강제 동기화
      if (status !== 'RECEIVING') {
        setStatus('RECEIVING');
      }

      // 3. 🚀 [성능 최적화] UI 업데이트 스로틀링
      const now = Date.now();
      const val = typeof p === 'object' ? (p.progress ?? 0) : p;

      // 100ms가 안 지났고, 완료(100%)가 아니면 업데이트 스킵
      if (
        now - lastProgressUpdateRef.current < UI_UPDATE_INTERVAL &&
        val < 100
      ) {
        return;
      }
      lastProgressUpdateRef.current = now;

      // 4. 진행률 데이터 업데이트
      updateProgress({ progress: isNaN(val) ? 0 : val });

      if (typeof p === 'object' && p.speed !== undefined) {
        setProgressData({
          progress: p.progress || 0,
          speed: p.speed || 0,
          bytesTransferred: p.bytesTransferred || 0,
          totalBytes: p.totalBytes || 0,
        });
      }
    },
    [status, setStatus, updateProgress]
  );

  const handleComplete = useCallback(
    (payload: ReceiverCompletePayload) => {
      debugLog('[ReceiverView] Transfer Complete.', payload);
      if (payload.actualSize) {
        setActualSize(payload.actualSize);
      }
      setStatus('DONE');
    },
    [setStatus]
  );

  // 🚨 [핵심 수정] room-full 이벤트 핸들러
  const handleRoomFull = useCallback(
    (msg: string) => {
      console.warn('[ReceiverView] Room full:', msg);
      if (connectionTimeoutRef.current)
        clearTimeout(connectionTimeoutRef.current);
      setErrorMsg(msg);
      setStatus('ROOM_FULL');
    },
    [setStatus]
  );

  const handleError = useCallback(
    (e: unknown) => {
      console.error('[ReceiverView] Error:', e);
      if (connectionTimeoutRef.current)
        clearTimeout(connectionTimeoutRef.current);
      setIsWaitingForSender(false);

      const msg = getErrorMessage(e, 'Unknown Error');
      if (msg.includes('Room full')) {
        // 🚨 [핵심 수정] 방이 꽉 찼을 때 ERROR가 아닌 ROOM_FULL 상태로 전환
        setErrorMsg(
          'Room is currently occupied. Please wait for the current transfer to complete.'
        );
        setStatus('ROOM_FULL');
        return;
      }
      const currentStatus = statusRef.current;
      if (msg.includes('closed')) {
        if (currentStatus === 'DONE' || currentStatus === 'IDLE') {
          return;
        }
        setErrorMsg('Connection closed before the file transfer completed.');
        setStatus('ERROR');
        return;
      }

      setErrorMsg(msg);
      setStatus('ERROR');
    },
    [setStatus]
  );

  const handleJoin = useCallback(
    async (id: string) => {
      if (!id || id.length < 6) return;

      setStatus('CONNECTING');
      setErrorMsg('');

      if (connectionTimeoutRef.current)
        clearTimeout(connectionTimeoutRef.current);

      // 🚨 [핵심 수정] 연결 타임아웃 로직 개선
      connectionTimeoutRef.current = setTimeout(() => {
        const currentStatus = statusRef.current;
        debugLog(
          '[ReceiverView] Timeout check. Current status:',
          currentStatus
        );

        // 🚨 [수정] 메타데이터를 받은 경우(정상 연결) 타임아웃 무시
        if (
          currentStatus === 'WAITING' ||
          currentStatus === 'RECEIVING' ||
          currentStatus === 'DONE'
        ) {
          debugLog('[ReceiverView] Timeout ignored - already connected');
          return;
        }

        // 🚨 [수정] 아직 CONNECTING 상태일 때만 타임아웃 처리
        if (currentStatus === 'CONNECTING') {
          console.warn(
            '[ReceiverView] Connection timed out. Status:',
            currentStatus
          );
          setErrorMsg('Connection timed out. Sender may be offline.');
          setStatus('ERROR');
          transferService.cleanup();
        }
      }, CONNECTION_TIMEOUT_MS);

      try {
        await transferService.initReceiver(id.toUpperCase());
      } catch (e) {
        if (connectionTimeoutRef.current)
          clearTimeout(connectionTimeoutRef.current);
        console.error('[ReceiverView] Init failed:', e);
        setErrorMsg('Failed to initialize connection');
        setStatus('ERROR');
      }
    },
    [setStatus]
  );

  // 🚨 [핵심 수정] 중복 초기화 방지를 위한 Ref
  const isInitializedRef = useRef(false);

  // 🚀 [Multi-Receiver] 전송 놓침 핸들러
  const handleTransferMissed = useCallback(
    (msg: string) => {
      console.warn('[ReceiverView] Transfer missed:', msg);
      if (connectionTimeoutRef.current)
        clearTimeout(connectionTimeoutRef.current);
      setIsWaitingForSender(false);
      setErrorMsg(
        'Transfer has already started. Please wait for it to complete or refresh to join the next transfer.'
      );
      setStatus('ERROR');
    },
    [setStatus]
  );

  // 🚀 [Multi-Receiver] 대기열 추가 핸들러
  const handleQueued = useCallback(
    (data: { message: string; position: number }) => {
      debugLog('[ReceiverView] Added to queue:', data);
      if (connectionTimeoutRef.current)
        clearTimeout(connectionTimeoutRef.current);
      setQueuePosition(data.position);
      setQueueMessage(data.message);
      setStatus('QUEUED');
    },
    [setStatus]
  );

  // 🚀 [Multi-Receiver] 전송 시작 핸들러 (대기열에서 나옴)
  const handleTransferStarting = useCallback(() => {
    debugLog('[ReceiverView] Transfer starting from queue');
    // 대기열 상태 초기화
    setQueuePosition(0);
    setQueueMessage('');
    // 진행률 초기화
    updateProgress({
      progress: 0,
      bytesTransferred: 0,
      totalBytes: manifest?.totalSize || 0,
    });
    setProgressData({
      progress: 0,
      speed: 0,
      bytesTransferred: 0,
      totalBytes: manifest?.totalSize || 0,
    });
    // 상태 전환
    setStatus('RECEIVING');
    setIsWaitingForSender(false);
  }, [manifest, updateProgress, setStatus]);

  // 🚀 [Multi-Receiver] 다운로드 가능 알림 핸들러
  const handleReadyForDownload = useCallback(
    (data: { message: string }) => {
      debugLog('[ReceiverView] Ready for download:', data);
      // 이미 WAITING 상태면 무시
      if (statusRef.current === 'WAITING') return;
      // QUEUED 상태에서 WAITING으로 전환
      if (statusRef.current === 'QUEUED') {
        setStatus('WAITING');
        setQueuePosition(0);
        setQueueMessage('');
      }
    },
    [setStatus]
  );

  const handleReconnecting = useCallback(() => {
    setIsWaitingForSender(true);
    setErrorMsg('');
    setStatus('RECEIVING');
  }, [setStatus]);

  const handleReconnected = useCallback(() => {
    setIsWaitingForSender(false);
    setErrorMsg('');
    setStatus('RECEIVING');
  }, [setStatus]);

  // 🚀 [핵심 수정] 이벤트 리스너 등록 Effect (한 번만 실행)
  useEffect(() => {
    // 리스너 등록
    transferService.on('metadata', handleMetadata);
    transferService.on('remote-started', handleRemoteStarted);
    transferService.on('progress', handleProgress);
    transferService.on('complete', handleComplete);
    transferService.on('error', handleError);
    transferService.on('room-full', handleRoomFull);
    transferService.on('transfer-missed', handleTransferMissed);
    transferService.on('queued', handleQueued);
    transferService.on('transfer-starting', handleTransferStarting);
    transferService.on('ready-for-download', handleReadyForDownload);
    transferService.on('reconnecting', handleReconnecting);
    transferService.on('reconnected', handleReconnected);

    return () => {
      // 🚀 [핵심] 클린업 시 리스너만 제거 (transferService.cleanup은 컴포넌트 언마운트 시에만)
      transferService.off('metadata', handleMetadata);
      transferService.off('remote-started', handleRemoteStarted);
      transferService.off('progress', handleProgress);
      transferService.off('complete', handleComplete);
      transferService.off('error', handleError);
      transferService.off('room-full', handleRoomFull);
      transferService.off('transfer-missed', handleTransferMissed);
      transferService.off('queued', handleQueued);
      transferService.off('transfer-starting', handleTransferStarting);
      transferService.off('ready-for-download', handleReadyForDownload);
      transferService.off('reconnecting', handleReconnecting);
      transferService.off('reconnected', handleReconnected);
    };
  }, [
    handleMetadata,
    handleRemoteStarted,
    handleProgress,
    handleComplete,
    handleError,
    handleRoomFull,
    handleTransferMissed,
    handleQueued,
    handleTransferStarting,
    handleReadyForDownload,
    handleReconnecting,
    handleReconnected,
  ]);

  // 🚀 [핵심 수정] 방 참여 Effect (roomId가 있을 때 한 번만 실행)
  useEffect(() => {
    if (roomId && !isInitializedRef.current) {
      isInitializedRef.current = true;
      handleJoin(roomId);
    }
  }, [roomId, handleJoin]);

  // 🚀 [핵심 수정] 컴포넌트 실제 언마운트 시에만 cleanup 실행
  // React StrictMode에서 useEffect가 두 번 실행되는 문제 방지
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      if (connectionTimeoutRef.current)
        clearTimeout(connectionTimeoutRef.current);

      // StrictMode에서 첫 번째 cleanup은 무시하고, 실제 언마운트 시에만 실행
      // 약간의 딜레이를 주어 StrictMode의 재마운트를 감지
      setTimeout(() => {
        if (!isMountedRef.current) {
          debugLog('[ReceiverView] Component unmounted, cleaning up...');
          transferService.cleanup();
        }
      }, 100);
    };
  }, []);

  /**
   * 🚀 [핵심] 사용자가 "Start Download"를 누르면
   * 저장 위치를 확보하고(또는 스트림을 열고) 전송을 시작함
   * OPFS 제거 - DirectFileWriter만 사용 (무제한 파일 크기 지원)
   */
  const startDirectDownload = useCallback(async () => {
    if (!manifest) return;

    try {
      // 다운로드 시작 시 기존 타임아웃 즉시 해제
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }

      setIsWaitingForSender(true);
      setStatus('RECEIVING');

      // DirectFileWriter 사용 (File System Access API 또는 StreamSaver)
      // 브라우저 저장소 quota 제한 없이 무제한 파일 크기 지원
      debugLog(
        '[ReceiverView] Using DirectFileWriter (no storage quota limit)'
      );
      debugLog(
        '[ReceiverView] Manifest:',
        manifest.totalFiles,
        'files,',
        (manifest.totalSize / (1024 * 1024)).toFixed(2),
        'MB'
      );

      const writer = new DirectFileWriter();

      // 서비스에 Writer 주입
      transferService.setWriter(writer);

      // 🚨 [핵심] 수신 시작 - 이 함수가 완료되어야 TRANSFER_READY가 전송됨
      debugLog('[ReceiverView] Starting receiver initialization...');
      await transferService.startReceiving(manifest);
      debugLog('[ReceiverView] ✅ Receiver initialization complete');

      // 다운로드 시작 후 새로운 타임아웃 설정 (송신자 응답 대기)
      connectionTimeoutRef.current = setTimeout(() => {
        if (
          statusRef.current === 'RECEIVING' &&
          isWaitingForSenderRef.current
        ) {
          console.warn(
            '[ReceiverView] Download start timeout - no response from sender'
          );
          setErrorMsg('Sender did not respond. Please try again.');
          setStatus('ERROR');
          setIsWaitingForSender(false);
          transferService.cleanup();
        }
      }, 10000); // 10초 타임아웃
    } catch (e) {
      console.error('[ReceiverView] startDirectDownload error:', e);

      if (getErrorName(e) === 'AbortError') {
        debugLog('[ReceiverView] User cancelled file selection');
        setIsWaitingForSender(false);
        setStatus('WAITING');
        return;
      }

      const errorMessage = getErrorMessage(e, String(e));
      console.error(
        '[ReceiverView] Download initialization failed:',
        errorMessage
      );
      setErrorMsg('Failed to initialize download: ' + errorMessage);
      setStatus('ERROR');
      setIsWaitingForSender(false);
    }
  }, [manifest, setStatus]);

  // Progress Calculation
  const safeProgress =
    isNaN(progress.progress) || progress.progress < 0 ? 0 : progress.progress;
  const strokeDashoffset = 283 - (283 * safeProgress) / 100; // 2 * PI * 45 ≈ 283
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

  // Common Styles
  const glassPanelClass =
    'bg-black/40 p-3 backdrop-blur-2xl border border-white/10 rounded-[2rem] shadow-2xl w-full max-w-md mx-4 overflow-hidden relative';

  return (
    <div className="flex flex-col items-center justify-center w-full h-full px-4 md:px-0 z-10 relative">
      <AnimatePresence mode="wait">
        {/* --- STATE: IDLE (Enter Code) --- */}
        {status === 'IDLE' && (
          <motion.div
            key="idle"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20, filter: 'blur(10px)' }}
            className={glassPanelClass}
          >
            <div className="text-center relative z-10 p-6 md:p-8">
              <div className="w-16 h-16 md:w-20 md:h-20 mx-auto mb-6 bg-gradient-to-br from-cyan-500/20 to-purple-500/20 rounded-3xl flex items-center justify-center border border-white/10 shadow-[0_0_30px_rgba(168,85,247,0.2)]">
                <Scan className="w-8 h-8 md:w-10 md:h-10 text-white drop-shadow-lg" />
              </div>

              <h2 className="text-2xl md:text-3xl font-bold mb-6 brand-font tracking-widest text-white">
                ENTER <span className="text-cyan-400">WARP KEY</span>
              </h2>

              <div className="relative group mb-6">
                <input
                  value={roomId || ''}
                  onChange={e => setRoomId(e.target.value.toUpperCase())}
                  placeholder="000000"
                  maxLength={6}
                  className="w-full bg-black/60 border-2 border-gray-700 rounded-2xl py-4 md:py-6 px-4 text-center text-3xl md:text-5xl font-mono text-cyan-400 tracking-[0.3em] md:tracking-[0.5em] outline-none focus:border-cyan-500 focus:shadow-[0_0_30px_rgba(6,182,212,0.3)] transition-all placeholder-white/10"
                />
                <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-cyan-500/50 rounded-tl-lg -translate-x-2 -translate-y-2 transition-all group-focus-within:translate-x-0 group-focus-within:translate-y-0 opacity-0 group-focus-within:opacity-100" />
                <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-purple-500/50 rounded-br-lg translate-x-2 translate-y-2 transition-all group-focus-within:translate-x-0 group-focus-within:translate-y-0 opacity-0 group-focus-within:opacity-100" />
              </div>

              <button
                onClick={() => handleJoin(roomId!)}
                disabled={!roomId || roomId.length < 6}
                className="w-full bg-white text-black py-4 rounded-xl font-bold text-base md:text-lg tracking-[0.2em] hover:bg-cyan-300 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
              >
                ESTABLISH LINK
              </button>
            </div>
          </motion.div>
        )}

        {/* --- STATE: CONNECTING --- */}
        {status === 'CONNECTING' && (
          <motion.div
            key="connecting"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="text-center"
          >
            <div className="relative w-32 h-32 mx-auto mb-8">
              <div className="absolute inset-0 border-4 border-t-cyan-500 border-r-transparent border-b-purple-500 border-l-transparent rounded-full animate-spin" />
              <div className="absolute inset-4 border-4 border-t-transparent border-r-white/30 border-b-transparent border-l-white/30 rounded-full animate-spin-reverse" />
              <Radio
                className="absolute inset-0 m-auto text-cyan-400 animate-pulse"
                size={32}
              />
            </div>
            <h3 className="text-2xl font-bold mb-2 tracking-widest">
              SEARCHING FREQUENCY...
            </h3>
            <p className="text-cyan-400/60 font-mono">
              Waiting for sender signal
            </p>
          </motion.div>
        )}

        {/* --- STATE: QUEUED --- */}
        {status === 'QUEUED' && (
          <motion.div
            key="queued"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            className={glassPanelClass}
          >
            <div className="text-center relative z-10 p-6 md:p-8">
              <div className="w-20 h-20 mx-auto mb-6 bg-cyan-500/10 rounded-full flex items-center justify-center border border-cyan-500/20">
                <Radio className="w-10 h-10 text-cyan-400 animate-pulse" />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold text-white mb-2 tracking-wider brand-font">
                QUEUED
              </h2>
              <p className="text-cyan-300 font-mono mb-2">
                Position {queuePosition || '-'}
              </p>
              <p className="text-gray-400 text-sm">
                {queueMessage || 'Waiting for an available sender slot'}
              </p>
            </div>
          </motion.div>
        )}

        {/* --- STATE: WAITING (Metadata Received) --- */}
        {status === 'WAITING' && (
          <motion.div
            key="waiting"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            className={glassPanelClass}
          >
            <div className="text-center relative z-10">
              <div className="w-20 h-20 mx-auto mb-6 bg-cyan-500/10 rounded-full flex items-center justify-center border border-cyan-500/20">
                <Archive className="w-10 h-10 text-cyan-400 drop-shadow-[0_0_15px_rgba(6,182,212,0.5)]" />
              </div>

              <h2 className="text-2xl md:text-3xl font-bold text-white mb-2 tracking-wider brand-font">
                INCOMING TRANSMISSION
              </h2>

              {/* File Info Box */}
              <div className="bg-gray-800/50 p-6 rounded-2xl mb-8 border border-gray-700/50 text-left">
                <div className="flex items-start gap-4 mb-4">
                  <div className="bg-gray-700/50 p-3 rounded-lg">
                    {manifest?.isFolder ? (
                      <Folder className="text-yellow-400" size={24} />
                    ) : (
                      <FileIcon className="text-blue-400" size={24} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-lg text-white truncate break-all">
                      {manifest?.rootName}
                    </p>
                    <p className="text-sm text-gray-400">
                      {manifest?.isFolder ? 'Folder Archive' : 'Single File'}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 border-t border-gray-700 pt-4">
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                      Total Size
                    </p>
                    <p className="font-mono text-cyan-300 font-bold">
                      {formatBytes(manifest?.totalSize || 0)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                      File Count
                    </p>
                    <p className="font-mono text-white font-bold">
                      {manifest?.totalFiles}
                    </p>
                  </div>
                </div>
              </div>

              {errorMsg && (
                <div className="mb-6 p-4 bg-red-900/30 border border-red-500/30 rounded-xl text-sm text-red-200 flex items-start gap-3 text-left">
                  <AlertCircle size={18} className="flex-shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <button
                onClick={startDirectDownload}
                className="w-full bg-white text-black py-4 rounded-xl font-bold tracking-widest hover:bg-cyan-300 transition-all flex items-center justify-center gap-3 shadow-[0_0_20px_rgba(255,255,255,0.2)] group"
              >
                <Download
                  size={20}
                  className="group-hover:scale-110 transition-transform"
                />
                MATERIALIZE
              </button>
            </div>
          </motion.div>
        )}

        {/* 4. RECEIVING (REVERSE WARP VISIBLE) */}
        {status === 'RECEIVING' && (
          <div className="text-center w-full max-w-2xl relative">
            {/* 중앙 HUD 스타일 프로그레스 */}
            <div className="relative w-64 h-64 mx-auto mb-8">
              {/* 배경 링 */}
              <svg
                className="w-full h-full rotate-[-90deg]"
                viewBox="0 0 100 100"
              >
                <circle
                  cx="50"
                  cy="50"
                  r="45"
                  fill="none"
                  stroke="rgba(255,255,255,0.1)"
                  strokeWidth="2"
                />
                {/* 진행 링 */}
                <circle
                  cx="50"
                  cy="50"
                  r="45"
                  fill="none"
                  stroke="url(#gradient)"
                  strokeWidth="4"
                  strokeDasharray="283"
                  strokeDashoffset={
                    isNaN(strokeDashoffset) ? 283 : strokeDashoffset
                  }
                  className="transition-all duration-300 ease-out drop-shadow-[0_0_10px_rgba(6,182,212,0.8)]"
                />
                <defs>
                  <linearGradient
                    id="gradient"
                    x1="0%"
                    y1="0%"
                    x2="100%"
                    y2="0%"
                  >
                    <stop offset="0%" stopColor="#22d3ee" />
                    <stop offset="100%" stopColor="#a855f7" />
                  </linearGradient>
                </defs>
              </svg>
              {/* 중앙 정보 */}
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-5xl font-black font-rajdhani text-white drop-shadow-lg">
                  {Math.round(safeProgress)}
                  <span className="text-2xl text-cyan-400">%</span>
                </span>
                <span className="text-xs text-cyan-300/80 font-mono mt-2 tracking-widest">
                  INCOMING STREAM
                </span>
                <span className="text-[10px] text-cyan-100/60 font-mono mt-2 px-4 text-center">
                  {transferFeedbackLabel}
                </span>
              </div>
            </div>

            {/* 하단 정보 패널 (투명) */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-black/20 backdrop-blur-md rounded-2xl p-6 border border-white/5">
              <div className="text-left">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                  Download Speed
                </p>
                <p className="font-mono text-xl text-cyan-400 font-bold">
                  {formatBytes(progressData.speed)}/s
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                  Data Received
                </p>
                <p className="font-mono text-xl text-white">
                  {formatBytes(progressData.bytesTransferred)}
                </p>
              </div>
              <div className="text-left sm:text-right">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                  Time Left
                </p>
                <p className="font-mono text-xl text-white">
                  {formatRemainingTime(estimatedSecondsRemaining)}
                </p>
              </div>
            </div>

            <p className="mt-8 text-cyan-500/50 text-sm animate-pulse tracking-[0.2em] font-mono">
              &lt;&lt;&lt; RECEIVING MATTER STREAM &lt;&lt;&lt;
            </p>
          </div>
        )}

        {/* --- STATE: DONE --- */}
        {status === 'DONE' && (
          <motion.div
            key="done"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className={glassPanelClass + ' border-green-500/30'}
          >
            <div className="text-center relative z-10">
              <div className="relative w-24 h-24 mx-auto mb-6 bg-green-500/10 rounded-full flex items-center justify-center border border-green-500/20">
                <CheckCircle className="w-12 h-12 text-green-400 drop-shadow-[0_0_15px_rgba(74,222,128,0.5)]" />
              </div>
              <h2 className="text-3xl font-bold text-white mb-2 tracking-wider brand-font">
                MATERIALIZED
              </h2>
              <p className="text-gray-400 mb-8">
                File reconstruction complete.
              </p>
              {actualSize > 0 && (
                <p className="text-gray-500 text-sm mb-6 font-mono">
                  {(actualSize / (1024 * 1024)).toFixed(2)} MB transferred
                </p>
              )}
              <button
                onClick={() => window.location.reload()}
                className="bg-white/10 border border-white/20 text-white px-8 py-3 rounded-full hover:bg-white/20 transition-all flex items-center gap-2 mx-auto"
              >
                <RefreshCw size={18} /> Process Next
              </button>
            </div>
          </motion.div>
        )}

        {/* --- STATE: ERROR --- */}
        {status === 'ERROR' && (
          <motion.div
            key="error"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className={glassPanelClass + ' border-red-500/30'}
          >
            <div className="text-center relative z-10">
              <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4 drop-shadow-[0_0_15px_rgba(239,68,68,0.5)]" />
              <h2 className="text-2xl font-bold mb-2 text-white tracking-wider">
                CONNECTION FAILED
              </h2>
              <p className="text-gray-300 mb-6">{errorMsg}</p>
              <button
                onClick={() => window.location.reload()}
                className="bg-white/10 border border-white/20 text-white px-6 py-3 rounded-full hover:bg-white/20 flex items-center gap-2 mx-auto transition-all"
              >
                <RefreshCw size={18} /> Retry Transfer
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default ReceiverView;
