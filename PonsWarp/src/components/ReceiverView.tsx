import { debugLog } from '../utils/logger';
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
import { lanEvidenceAdapter } from '../services/lanEvidenceAdapter';
import { DirectFileWriter } from '../services/directFileWriter';
import { formatBytes } from '../utils/fileUtils';
import { motion, AnimatePresence } from 'framer-motion';
import { useTransferStore } from '../store/transferStore';
import { toast } from '../store/toastStore';
import { TransferManifest } from '../types/types';
import { getErrorMessage, getErrorName } from '../utils/errors';
import { isCompleteRoomCode, normalizeRoomCodeInput } from '../utils/roomCode';
import { normalizeCloudShareCodeInput } from '../utils/cloudShareCode';
import {
  estimateRemainingSeconds,
  formatRemainingTime,
  getTransferFeedbackLabel,
} from '../utils/transferEstimate';
import { formatSlowPathBanner } from '../services/hybridBulkTransport';

interface ReceiverViewProps {
  onOpenCloudShare?: (shareId: string) => void;
}

type ReceiverProgressPayload = {
  progress?: number;
  speed?: number;
  bytesTransferred?: number;
  totalBytes?: number;
  pathKind?: string;
  protocol?: string | null;
  rttMs?: number | null;
};

type ReceiverCompletePayload = {
  actualSize?: number;
};

const ReceiverView: React.FC<ReceiverViewProps> = ({ onOpenCloudShare }) => {
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

  const [receiveInput, setReceiveInput] = useState(roomId || '');
  const [errorMsg, setErrorMsg] = useState('');
  const [senderGone, setSenderGone] = useState(false);
  const [actualSize, setActualSize] = useState<number>(0);
  const [progressData, setProgressData] = useState({
    progress: 0,
    speed: 0,
    bytesTransferred: 0,
    totalBytes: 0,
    pathKind: 'unknown' as string,
    protocol: null as string | null,
    rttMs: null as number | null,
  });

  // 🚨 [추가] 송신자 응답 대기 상태 변수
  const [isWaitingForSender, setIsWaitingForSender] = useState(false);
  const isWaitingForSenderRef = useRef(isWaitingForSender);
  useEffect(() => {
    isWaitingForSenderRef.current = isWaitingForSender;
  }, [isWaitingForSender]);

  // 대기열 상태 (단일 피어: 송신자 준비 대기 메시지)
  const [queueMessage, setQueueMessage] = useState<string>('');

  // 🚨 [추가] 연결 타임아웃 관리용 Ref
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 🚨 [핵심 수정] 중복 참여 방지 Ref — ERROR 또는 코드 변경 시 리셋되어 재시도 가능
  const isInitializedRef = useRef(false);
  const prevRoomIdRef = useRef(roomId);

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

      // QUEUED 상태에서 manifest를 다시 받으면 전송 시작
      const currentStatus = statusRef.current;
      if (currentStatus === 'QUEUED') {
        debugLog(
          '[ReceiverView] Manifest received while QUEUED - transfer starting'
        );
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
          pathKind: 'unknown',
          protocol: null,
          rttMs: null,
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
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
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

      if (typeof p === 'object') {
        setProgressData(prev => ({
          progress: p.progress ?? prev.progress ?? 0,
          speed: p.speed ?? prev.speed ?? 0,
          bytesTransferred: p.bytesTransferred ?? prev.bytesTransferred ?? 0,
          totalBytes: p.totalBytes ?? prev.totalBytes ?? 0,
          pathKind: p.pathKind || prev.pathKind || 'unknown',
          protocol: p.protocol ?? prev.protocol ?? null,
          rttMs: typeof p.rttMs === 'number' ? p.rttMs : prev.rttMs,
        }));
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
      const normalizedRoomId = normalizeRoomCodeInput(id);
      if (!normalizedRoomId || normalizedRoomId.length < 6) return;

      // 직접 호출(재시도 버튼 등)도 중복 참여 가드를 통과한 것으로 표시
      isInitializedRef.current = true;

      if (normalizedRoomId !== id) {
        setRoomId(normalizedRoomId);
      }

      setReceiveInput(normalizedRoomId);

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
        await transferService.initReceiver(normalizedRoomId);
      } catch (e) {
        if (connectionTimeoutRef.current)
          clearTimeout(connectionTimeoutRef.current);
        console.error('[ReceiverView] Init failed:', e);
        setErrorMsg('Failed to initialize connection');
        setStatus('ERROR');
      }
    },
    [setRoomId, setStatus]
  );

  const handleSubmitReceiveInput = useCallback(() => {
    const cloudShareCode = normalizeCloudShareCodeInput(receiveInput);
    if (cloudShareCode && onOpenCloudShare) {
      onOpenCloudShare(cloudShareCode.toLowerCase());
      return;
    }

    const normalizedRoomId = normalizeRoomCodeInput(receiveInput);
    if (!isCompleteRoomCode(normalizedRoomId)) return;

    // 같은 코드 재제출 시 roomId가 변하지 않아 effect가 재실행되지 않으므로
    // (ERROR 후 재시도 등) 가드가 열려 있으면 직접 재참여한다.
    if (normalizedRoomId === roomId && !isInitializedRef.current) {
      handleJoin(normalizedRoomId);
      return;
    }

    // Only set roomId here. The roomId effect owns the single join call so
    // submit + effect cannot fire JoinRoom twice for the same receiver.
    setRoomId(normalizedRoomId);
  }, [onOpenCloudShare, receiveInput, roomId, setRoomId, handleJoin]);

  // 전송 놓침 핸들러
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

  const handleQueued = useCallback(
    (data: { message: string; position: number }) => {
      debugLog('[ReceiverView] Added to queue:', data);
      if (connectionTimeoutRef.current)
        clearTimeout(connectionTimeoutRef.current);
      setQueueMessage(data.message);
      setStatus('QUEUED');
    },
    [setStatus]
  );

  // 대기열에서 전송 시작 처리 (단일 피어)
  const handleTransferStarting = useCallback(() => {
    debugLog('[ReceiverView] Transfer starting from queue');
    // 대기열 상태 초기화
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
      pathKind: 'unknown',
      protocol: null,
      rttMs: null,
    });
    // 상태 전환
    setStatus('RECEIVING');
    setIsWaitingForSender(false);
  }, [manifest, updateProgress, setStatus]);

  // 다운로드 가능 알림 핸들러
  const handleReadyForDownload = useCallback(
    (data: { message: string }) => {
      debugLog('[ReceiverView] Ready for download:', data);
      // 이미 WAITING 상태면 무시
      if (statusRef.current === 'WAITING') return;
      // QUEUED 상태에서 WAITING으로 전환
      if (statusRef.current === 'QUEUED') {
        setStatus('WAITING');
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

  // Sender가 방을 떠남 (offer 이후 확실히 식별된 경우에만 발생)
  // 주의: 시그널링 WS flap 시 송신자는 새 peer_id로 재참여·re-offer하므로
  // 여기서 즉시 ERROR+cleanup하면 복구 가능한 세션을 죽인다.
  // 종료 상태는 기존 경로가 커버: CONNECTING은 45초 타임아웃,
  // WAITING 이후는 TRANSFER_ABORTED/데이터채널 close.
  const handlePeerDisconnected = useCallback(() => {
    const s = statusRef.current;
    if (s === 'DONE') {
      // 전송은 끝났지만 방은 죽었다 — Process Next는 재사용 불가
      setSenderGone(true);
      return;
    }
    if (s === 'CONNECTING' || s === 'WAITING' || s === 'QUEUED') {
      toast.warning(
        'Sender left the room. Waiting briefly for reconnect…'
      );
    }
  }, []);

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
    transferService.on('peer-disconnected', handlePeerDisconnected);
    transferService.on('nat-probe', (result: { verdict: string }) => {
      if (result.verdict === 'relay-likely' || result.verdict === 'blocked') {
        toast.warning(
          'This network may require a relay — transfers can be slower but will still work.'
        );
      }
    });

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
    transferService.off('peer-disconnected', handlePeerDisconnected);
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
    handlePeerDisconnected,
  ]);

  // 🚨 [핵심 수정] ERROR 상태가 되면 참여 가드를 리셋해 재시도 가능하게 함
  // (join effect보다 먼저 선언해 같은 렌더에서 리셋이 먼저 적용되도록 함)
  useEffect(() => {
    if (status === 'ERROR') {
      isInitializedRef.current = false;
    }
  }, [status]);

  // 🚀 [핵심 수정] 방 참여 Effect (roomId가 있을 때 한 번만 실행)
  useEffect(() => {
    // 코드가 바뀌면 가드를 리셋해 새 코드로 재참여 가능하게 함
    // (StrictMode 재실행은 roomId가 같으므로 리셋되지 않아 중복 참여 방지 유지)
    if (roomId !== prevRoomIdRef.current) {
      prevRoomIdRef.current = roomId;
      isInitializedRef.current = false;
    }
    if (isCompleteRoomCode(roomId || '') && !isInitializedRef.current) {
      isInitializedRef.current = true;
      handleJoin(roomId!);
    }
  }, [roomId, handleJoin]);

  // 🚀 [핵심 수정] 컴포넌트 실제 언마운트 시에만 cleanup 실행
  // React StrictMode에서 useEffect가 두 번 실행되는 문제 방지
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;

      // StrictMode에서 첫 번째 cleanup은 무시하고, 실제 언마운트 시에만 실행
      // 약간의 딜레이를 주어 StrictMode의 재마운트를 감지
      // NOTE: connectionTimeoutRef clear는 반드시 이 블록 안에 있어야 한다 —
      // dev StrictMode의 fake-unmount cleanup이 join 타임아웃을 죽이면
      // 수신자가 CONNECTING에 무한 고착한다.
      setTimeout(() => {
        if (!isMountedRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          debugLog('[ReceiverView] Component unmounted, cleaning up...');
          transferService.cleanup();
          void lanEvidenceAdapter.release();
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
      const fileName =
        manifest.totalFiles === 1
          ? manifest.files[0].path.split('/').pop() || 'download'
          : `${manifest.rootName || 'download'}.zip`;
      const evidenceHandle =
        await lanEvidenceAdapter.pickReceiverSaveHandle(fileName);
      writer.setEvidenceFsaHandleContext(evidenceHandle);
      transferService.setWriter(writer);

      // 🚨 [핵심] 수신 시작 - 이 함수가 완료되어야 TRANSFER_READY가 전송됨
      debugLog('[ReceiverView] Starting receiver initialization...');
      await transferService.startReceiving(manifest);
      debugLog('[ReceiverView] ✅ Receiver initialization complete');

      // Wait for sender bulk/control after MATERIALIZE. Do NOT cleanup the
      // peer on a short timer — that tears down a healthy WebRTC session
      // while the sender is still pumping into a half-open channel.
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
      connectionTimeoutRef.current = setTimeout(() => {
        if (
          statusRef.current === 'RECEIVING' &&
          isWaitingForSenderRef.current
        ) {
          console.warn(
            '[ReceiverView] Download start timeout - no response from sender'
          );
          setErrorMsg(
            'Sender did not respond yet. Keep this page open or retry MATERIALIZE.'
          );
          setIsWaitingForSender(false);
          // Soft fail only: keep peer alive so late TRANSFER_STARTED/bulk can land.
        }
      }, 45000);
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
  const cloudShareCode = normalizeCloudShareCodeInput(receiveInput);
  const canSubmitReceiveInput =
    Boolean(cloudShareCode && onOpenCloudShare) ||
    isCompleteRoomCode(receiveInput);
  const transferFeedbackLabel = getTransferFeedbackLabel(
    progressData.bytesTransferred,
    progressData.totalBytes,
    progressData.speed
  );

  // Common Styles
  const glassPanelClass =
    'relative w-full max-w-md overflow-hidden rounded-[1.5rem] border border-white/10 bg-black/40 p-2 shadow-2xl backdrop-blur-2xl sm:mx-0 sm:rounded-[2rem] sm:p-3';

  return (
    <div className="relative z-10 flex h-full w-full flex-col items-center justify-center px-1 sm:px-3 md:px-0">
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
            <div className="relative z-10 p-4 text-center sm:p-6 md:p-8">
              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-3xl border border-white/10 bg-gradient-to-br from-cyan-500/20 to-purple-500/20 shadow-[0_0_30px_rgba(168,85,247,0.2)] sm:mb-6 sm:h-16 sm:w-16 md:h-20 md:w-20">
                <Scan className="w-8 h-8 md:w-10 md:h-10 text-white drop-shadow-lg" />
              </div>

              <h2 className="text-2xl md:text-3xl font-bold mb-6 brand-font tracking-widest text-white">
                ENTER <span className="text-cyan-400">WARP KEY</span>
              </h2>

              <div className="relative group mb-6">
                <input
                  value={receiveInput}
                  onChange={e => setReceiveInput(e.target.value)}
                  placeholder="CODE OR LINK"
                  maxLength={160}
                  className="w-full rounded-2xl border border-gray-600 bg-black/30 p-4 text-center font-mono text-lg uppercase tracking-[0.18em] text-white outline-none transition-all placeholder-gray-600 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 sm:p-5 sm:text-xl sm:tracking-[0.25em] md:p-6 md:text-3xl md:tracking-[0.5em]"
                />
                <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-cyan-500/50 rounded-tl-lg -translate-x-2 -translate-y-2 transition-all group-focus-within:translate-x-0 group-focus-within:translate-y-0 opacity-0 group-focus-within:opacity-100" />
                <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-purple-500/50 rounded-br-lg translate-x-2 translate-y-2 transition-all group-focus-within:translate-x-0 group-focus-within:translate-y-0 opacity-0 group-focus-within:opacity-100" />
              </div>

              <button
                onClick={handleSubmitReceiveInput}
                disabled={!canSubmitReceiveInput}
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

        {/* --- STATE: QUEUED (전송 대기) --- */}
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
                WAITING
              </h2>
              <p className="text-gray-400 text-sm">
                {queueMessage || 'Waiting for the sender to be ready'}
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
            <div className="relative z-10 p-3 text-center sm:p-4 md:p-0">
              <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-cyan-500/20 bg-cyan-500/10 sm:mb-6 sm:h-20 sm:w-20">
                <Archive className="h-8 w-8 text-cyan-400 drop-shadow-[0_0_15px_rgba(6,182,212,0.5)] sm:h-10 sm:w-10" />
              </div>

              <h2 className="mb-2 brand-font text-xl font-bold tracking-wider text-white sm:text-2xl md:text-3xl">
                INCOMING TRANSMISSION
              </h2>

              {/* File Info Box */}
              <div className="mb-6 rounded-2xl border border-gray-700/50 bg-gray-800/50 p-4 text-left sm:mb-8 sm:p-6">
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
          <div className="relative w-full max-w-2xl px-1 text-center sm:px-0">
            {/* 중앙 HUD 스타일 프로그레스 */}
            <div className="relative mx-auto mb-5 h-48 w-48 sm:mb-8 sm:h-64 sm:w-64">
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
                <span className="font-rajdhani text-4xl font-black text-white drop-shadow-lg sm:text-5xl">
                  {Math.round(safeProgress)}
                  <span className="text-xl text-cyan-400 sm:text-2xl">%</span>
                </span>
                <span className="text-xs text-cyan-300/80 font-mono mt-2 tracking-widest">
                  INCOMING STREAM
                </span>
                {isWaitingForSender && (
                  <span className="mt-2 px-3 py-1 rounded-full bg-amber-500/15 border border-amber-500/40 text-[10px] font-mono text-amber-300 animate-pulse tracking-widest">
                    RECONNECTING...
                  </span>
                )}
                <span className="text-[10px] text-cyan-100/60 font-mono mt-2 px-4 text-center">
                  {transferFeedbackLabel}
                </span>
              </div>
            </div>

            {/* 하단 정보 패널 (투명) */}
            <div className="grid grid-cols-1 gap-3 rounded-2xl border border-white/5 bg-black/20 p-4 backdrop-blur-md sm:grid-cols-3 sm:gap-4 sm:p-6">
              <div className="text-left">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                  Download Speed
                </p>
                <p className="font-mono text-lg font-bold text-cyan-400 sm:text-xl">
                  {formatBytes(progressData.speed)}/s
                </p>
              </div>
              <div className="text-left sm:text-right">
                <p className="mb-1 text-xs uppercase tracking-wider text-gray-500">
                  Data Received
                </p>
                <p className="font-mono text-lg text-white sm:text-xl">
                  {formatBytes(progressData.bytesTransferred)}
                </p>
              </div>
              <div className="text-left sm:text-right">
                <p className="mb-1 text-xs uppercase tracking-wider text-gray-500">
                  Time Left
                </p>
                <p className="font-mono text-lg text-white sm:text-xl">
                  {formatRemainingTime(estimatedSecondsRemaining)}
                </p>
              </div>
            </div>

            <p
              className={`mt-2 px-2 text-center font-mono text-[10px] leading-relaxed break-words sm:text-[11px] ${
                progressData.pathKind === 'relay'
                  ? 'text-amber-300'
                  : 'text-cyan-200/70'
              }`}
            >
              {formatSlowPathBanner({
                pathKind: progressData.pathKind,
                protocol: progressData.protocol,
                rttMs: progressData.rttMs,
              })}
            </p>

            <p className="mt-5 animate-pulse px-2 font-mono text-[11px] tracking-[0.14em] text-cyan-500/50 sm:mt-8 sm:text-sm sm:tracking-[0.2em]">
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
              <h2 className="mb-2 brand-font text-2xl font-bold tracking-wider text-white sm:text-3xl">
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
                onClick={() => {
                  // 방은 송신자가 떠나면 이미 삭제됐다 — reload 대신
                  // 수신 입력 화면으로 돌아가 새 코드를 받을 수 있게 한다.
                  transferService.cleanup();
                  setManifest(null);
                  setRoomId(null);
                  setReceiveInput('');
                  setActualSize(0);
                  setSenderGone(false);
                  setErrorMsg('');
                  setStatus('IDLE');
                }}
                className="bg-white/10 border border-white/20 text-white px-8 py-3 rounded-full hover:bg-white/20 transition-all flex items-center gap-2 mx-auto"
              >
                <RefreshCw size={18} />{' '}
                {senderGone ? 'Receive Another' : 'Process Next'}
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
                onClick={() => {
                  // roomId가 있으면 재참여, 없으면 기존처럼 새로고침
                  if (roomId) handleJoin(roomId);
                  else window.location.reload();
                }}
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
