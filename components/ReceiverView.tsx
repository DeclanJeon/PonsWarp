import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Scan, Download, Loader2, Archive, AlertCircle, CheckCircle, FileCheck, RefreshCw } from 'lucide-react';
import { transferService } from '../services/webRTCService';
import { CONNECTION_TIMEOUT_MS } from '../constants';
import { DirectFileWriter } from '../services/directFileWriter';
import { formatBytes } from '../utils/fileUtils';
import { AppMode } from '../types';

interface ReceiverViewProps {
  autoRoomId?: string | null;
}

const ReceiverView: React.FC<ReceiverViewProps> = ({ autoRoomId }) => {
  const [roomId, setRoomId] = useState(autoRoomId || '');
  const [status, setStatus] = useState<'SCANNING' | 'CONNECTING' | 'WAITING' | 'RECEIVING' | 'DONE' | 'ERROR' | 'ROOM_FULL' | 'QUEUED'>('SCANNING');
  const [manifest, setManifest] = useState<any>(null);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [actualSize, setActualSize] = useState<number>(0);
  const [progressData, setProgressData] = useState({ progress: 0, speed: 0, bytesTransferred: 0, totalBytes: 0 });
  
  // 🚨 [추가] 송신자 응답 대기 상태 변수
  const [isWaitingForSender, setIsWaitingForSender] = useState(false);
  
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
  const handleMetadata = useCallback((m: any) => {
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
      console.log('[ReceiverView] Manifest received while QUEUED - transfer starting');
      setQueuePosition(0);
      setQueueMessage('');
      setProgress(0);
      setProgressData({ progress: 0, speed: 0, bytesTransferred: 0, totalBytes: m?.totalSize || 0 });
      setStatus('RECEIVING');
      setIsWaitingForSender(false);
    } else if (currentStatus !== 'RECEIVING' && currentStatus !== 'DONE') {
      // 일반적인 경우: WAITING 상태로 전환
      setStatus('WAITING');
    }
  }, []);

  const handleRemoteStarted = useCallback(() => {
    // 🚨 [핵심 수정] 송신자 응답 시 타임아웃 해제
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    setIsWaitingForSender(false);
  }, []);

  const handleProgress = useCallback((p: any) => {
    // 1. 대기 상태 해제 (데이터가 들어오기 시작함)
    setIsWaitingForSender(false);
    
    // 2. 상태 강제 동기화 (함수형 업데이트로 안전하게 처리)
    setStatus(prev => (prev !== 'RECEIVING' ? 'RECEIVING' : prev));

    // 3. 🚀 [성능 최적화] UI 업데이트 스로틀링
    //    너무 잦은 업데이트는 메인 스레드 부하를 증가시켜 다운로드 속도 저하
    const now = Date.now();
    const val = typeof p === 'object' ? p.progress : p;
    
    // 100ms가 안 지났고, 완료(100%)가 아니면 업데이트 스킵
    if (now - lastProgressUpdateRef.current < UI_UPDATE_INTERVAL && val < 100) {
      return;
    }
    lastProgressUpdateRef.current = now;

    // 4. 진행률 데이터 업데이트
    setProgress(isNaN(val) ? 0 : val);
    
    if (typeof p === 'object' && p.speed !== undefined) {
      setProgressData({
        progress: p.progress || 0,
        speed: p.speed || 0,
        bytesTransferred: p.bytesTransferred || 0,
        totalBytes: p.totalBytes || 0
      });
    }
  }, []);

  const handleComplete = useCallback((payload: any) => {
    console.log('[ReceiverView] Transfer Complete.', payload);
    if (payload && payload.actualSize) {
      setActualSize(payload.actualSize);
    }
    setStatus('DONE');
  }, []);

  // 🚨 [핵심 수정] room-full 이벤트 핸들러
  const handleRoomFull = useCallback((msg: string) => {
    console.warn('[ReceiverView] Room full:', msg);
    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    setErrorMsg(msg);
    setStatus('ROOM_FULL');
  }, []);

  const handleError = useCallback((e: any) => {
    console.error('[ReceiverView] Error:', e);
    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    setIsWaitingForSender(false);
    
    let msg = typeof e === 'string' ? e : 'Unknown Error';
    if (msg.includes('Room full')) {
      // 🚨 [핵심 수정] 방이 꽉 찼을 때 ERROR가 아닌 ROOM_FULL 상태로 전환
      setErrorMsg('Room is currently occupied. Please wait for the current transfer to complete.');
      setStatus('ROOM_FULL');
      return;
    }
    if (msg.includes('closed')) return; // 단순 종료 무시
    
    // 🚨 [핵심 수정] 이미 다운로드 중인 경우 에러 상태로 전환 방지
    const currentStatus = statusRef.current;
    if (currentStatus === 'RECEIVING' && !isWaitingForSender) {
      console.warn('[ReceiverView] Error ignored - already transferring');
      return;
    }

    setErrorMsg(msg);
    setStatus('ERROR');
  }, []);

  const handleJoin = useCallback(async (id: string) => {
    if (!id || id.length < 6) return;
    
    setStatus('CONNECTING');
    setErrorMsg('');
    
    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    
    // 🚨 [핵심 수정] 연결 타임아웃 로직 개선
    connectionTimeoutRef.current = setTimeout(() => {
        const currentStatus = statusRef.current;
        console.log('[ReceiverView] Timeout check. Current status:', currentStatus);
        
        // 🚨 [수정] 메타데이터를 받은 경우(정상 연결) 타임아웃 무시
        if (currentStatus === 'WAITING' || currentStatus === 'RECEIVING' || currentStatus === 'DONE') {
            console.log('[ReceiverView] Timeout ignored - already connected');
            return;
        }
        
        // 🚨 [수정] 아직 CONNECTING 상태일 때만 타임아웃 처리
        if (currentStatus === 'CONNECTING') {
            console.warn('[ReceiverView] Connection timed out. Status:', currentStatus);
            setErrorMsg('Connection timed out. Sender may be offline.');
            setStatus('ERROR');
            transferService.cleanup();
        }
    }, CONNECTION_TIMEOUT_MS);

    try {
      await transferService.initReceiver(id.toUpperCase());
    } catch (e) {
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      console.error('[ReceiverView] Init failed:', e);
      setErrorMsg('Failed to initialize connection');
      setStatus('ERROR');
    }
  }, []);

  // 🚨 [핵심 수정] 중복 초기화 방지를 위한 Ref
  const isInitializedRef = useRef(false);

  // 🚀 [Multi-Receiver] 전송 놓침 핸들러
  const handleTransferMissed = useCallback((msg: string) => {
    console.warn('[ReceiverView] Transfer missed:', msg);
    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    setIsWaitingForSender(false);
    setErrorMsg('Transfer has already started. Please wait for it to complete or refresh to join the next transfer.');
    setStatus('ERROR');
  }, []);

  // 🚀 [Multi-Receiver] 대기열 추가 핸들러
  const handleQueued = useCallback((data: { message: string; position: number }) => {
    console.log('[ReceiverView] Added to queue:', data);
    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    setQueuePosition(data.position);
    setQueueMessage(data.message);
    setStatus('QUEUED');
  }, []);

  // 🚀 [Multi-Receiver] 전송 시작 핸들러 (대기열에서 나옴)
  const handleTransferStarting = useCallback(() => {
    console.log('[ReceiverView] Transfer starting from queue');
    // 대기열 상태 초기화
    setQueuePosition(0);
    setQueueMessage('');
    // 진행률 초기화
    setProgress(0);
    setProgressData({ progress: 0, speed: 0, bytesTransferred: 0, totalBytes: manifest?.totalSize || 0 });
    // 상태 전환
    setStatus('RECEIVING');
    setIsWaitingForSender(false); // 이미 전송이 시작되었으므로 대기 상태 해제
  }, [manifest]);

  // 🚀 [Multi-Receiver] 다운로드 가능 알림 핸들러
  const handleReadyForDownload = useCallback((data: { message: string }) => {
    console.log('[ReceiverView] Ready for download:', data);
    // 이미 WAITING 상태면 무시
    if (statusRef.current === 'WAITING') return;
    // QUEUED 상태에서 WAITING으로 전환
    if (statusRef.current === 'QUEUED') {
      setStatus('WAITING');
      setQueuePosition(0);
      setQueueMessage('');
    }
  }, []);

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
    };
  }, [handleMetadata, handleRemoteStarted, handleProgress, handleComplete, handleError, handleRoomFull, handleTransferMissed, handleQueued, handleTransferStarting, handleReadyForDownload]);

  // 🚀 [핵심 수정] 방 참여 Effect (autoRoomId가 있을 때 한 번만 실행)
  useEffect(() => {
    if (autoRoomId && !isInitializedRef.current) {
      isInitializedRef.current = true;
      handleJoin(autoRoomId);
    }
  }, [autoRoomId, handleJoin]);

  // 🚀 [핵심 수정] 컴포넌트 실제 언마운트 시에만 cleanup 실행
  // React StrictMode에서 useEffect가 두 번 실행되는 문제 방지
  const isMountedRef = useRef(true);
  
  useEffect(() => {
    isMountedRef.current = true;
    
    return () => {
      isMountedRef.current = false;
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      
      // StrictMode에서 첫 번째 cleanup은 무시하고, 실제 언마운트 시에만 실행
      // 약간의 딜레이를 주어 StrictMode의 재마운트를 감지
      setTimeout(() => {
        if (!isMountedRef.current) {
          console.log('[ReceiverView] Component unmounted, cleaning up...');
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
      console.log('[ReceiverView] Using DirectFileWriter (no storage quota limit)');
      console.log('[ReceiverView] Manifest:', manifest.totalFiles, 'files,', (manifest.totalSize / (1024 * 1024)).toFixed(2), 'MB');
      
      const writer = new DirectFileWriter();

      // 서비스에 Writer 주입
      transferService.setWriter(writer);

      // 🚨 [핵심] 수신 시작 - 이 함수가 완료되어야 TRANSFER_READY가 전송됨
      console.log('[ReceiverView] Starting receiver initialization...');
      await transferService.startReceiving(manifest);
      console.log('[ReceiverView] ✅ Receiver initialization complete');
      
      // 다운로드 시작 후 새로운 타임아웃 설정 (송신자 응답 대기)
      connectionTimeoutRef.current = setTimeout(() => {
        if (statusRef.current === 'RECEIVING' && isWaitingForSender) {
          console.warn('[ReceiverView] Download start timeout - no response from sender');
          setErrorMsg('Sender did not respond. Please try again.');
          setStatus('ERROR');
          setIsWaitingForSender(false);
          transferService.cleanup();
        }
      }, 10000); // 10초 타임아웃
      
    } catch (e: any) {
      console.error('[ReceiverView] startDirectDownload error:', e);
      
      if (e.name === 'AbortError') {
        console.log('[ReceiverView] User cancelled file selection');
        setIsWaitingForSender(false);
        setStatus('WAITING');
        return;
      }
      
      const errorMessage = e.message || String(e);
      console.error('[ReceiverView] Download initialization failed:', errorMessage);
      setErrorMsg('Failed to initialize download: ' + errorMessage);
      setStatus('ERROR');
      setIsWaitingForSender(false);
    }
  }, [manifest]);

  const safeProgress = isNaN(progress) || progress < 0 ? 0 : progress;
  const strokeDashoffset = 283 - (283 * safeProgress) / 100;

  return (
    <div className="flex flex-col items-center justify-center h-full w-full max-w-md mx-auto p-6">
      
      {/* 1. SCANNING */}
      {status === 'SCANNING' && (
        <div className="bg-black/80 p-8 rounded-3xl border border-gray-800 text-center w-full">
          <Scan className="w-16 h-16 text-cyan-500 mx-auto mb-4 animate-pulse" />
          <input
            value={roomId}
            onChange={(e) => setRoomId(e.target.value.toUpperCase())}
            placeholder="ROOM ID"
            maxLength={6}
            className="bg-gray-900 border border-gray-700 rounded-xl p-4 text-center text-2xl font-mono text-cyan-400 w-full mb-4 uppercase outline-none focus:border-cyan-500"
          />
          <button onClick={() => handleJoin(roomId)} className="w-full bg-cyan-600 hover:bg-cyan-500 py-3 rounded-xl font-bold transition-colors">
            CONNECT
          </button>
        </div>
      )}

      {/* 2. CONNECTING */}
      {status === 'CONNECTING' && (
        <div className="text-center w-full">
          <Loader2 className="w-16 h-16 text-cyan-500 animate-spin mx-auto mb-4" />
          <h3 className="text-xl font-bold mb-2">Connecting...</h3>
          <p className="text-gray-400 mb-8">Searching for Sender...</p>
          <button onClick={() => window.location.reload()} className="text-gray-500 hover:text-white underline text-sm">
            Cancel & Retry
          </button>
        </div>
      )}

      {/* 3. WAITING (File Info) - 🚨 [수정] 버튼 클릭 즉시 RECEIVING으로 전환 */}
      {status === 'WAITING' && (
        <div className="bg-black/80 p-8 rounded-3xl border border-gray-800 text-center w-full">
          <Archive className="w-16 h-16 text-cyan-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-white mb-2">Incoming Transfer</h2>
          <p className="text-gray-400 text-sm mb-6">
            {manifest?.totalFiles === 1 ? manifest?.files[0]?.name : `${manifest?.totalFiles} files`}
          </p>
          <p className="text-gray-500 text-sm mb-6">
            Size: {manifest ? (manifest.totalSize / (1024 * 1024)).toFixed(2) : '0'} MB
          </p>
          
          {errorMsg && (
            <div className="mb-4 p-3 bg-red-900/50 border border-red-500/50 rounded-lg text-sm text-red-200 flex items-center gap-2 text-left">
              <AlertCircle size={16} className="flex-shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <button
            onClick={startDirectDownload}
            className="bg-white text-black px-8 py-3 rounded-full font-bold hover:bg-gray-200 flex items-center gap-2 mx-auto transition-colors w-full justify-center"
          >
            <Download size={20} />
            Start Download
          </button>
        </div>
      )}

      {/* 4. RECEIVING - 🚀 [최적화] 세밀한 상태 관리 및 UI 분리 */}
      {status === 'RECEIVING' && (
        <div className="text-center w-full">
          {/* 헤더: 상태에 따른 동적 텍스트와 아이콘 */}
          <div className="flex items-center justify-center mb-6">
            {isWaitingForSender ? (
              <Loader2 className="w-8 h-8 text-yellow-500 animate-spin mr-3" />
            ) : (
              <CheckCircle className="w-8 h-8 text-green-500" />
            )}
            <h3 className="text-xl font-bold mb-2">
              {isWaitingForSender ? 'Preparing Transfer...' : 'Receiving Data'}
            </h3>
          </div>

          {/* 설명 텍스트 */}
          <p className="text-cyan-400 mb-6 truncate px-4">
            {manifest?.rootName || 'Downloading files...'}
          </p>
          
          {/* 프로그래스 바: 통합된 컴포넌트 */}
          <div className="relative w-48 h-48 mx-auto mb-6">
            <svg className="w-full h-full" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="45" fill="none" stroke="#1e293b" strokeWidth="8" />
              <circle
                cx="50" cy="50" r="45" fill="none"
                stroke={isWaitingForSender ? "#4b5563" : "#06b6d4"}
                strokeWidth="8"
                strokeDasharray="283"
                strokeDashoffset={isWaitingForSender ? 283 : (isNaN(strokeDashoffset) ? 283 : strokeDashoffset)}
                transform="rotate(-90 50 50)"
                className={`transition-all duration-300 ${isWaitingForSender ? 'opacity-60' : 'opacity-100'}`}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center text-3xl font-bold">
              {isWaitingForSender ? (
                <div className="flex flex-col items-center">
                  <Loader2 className="w-6 h-6 text-yellow-500 animate-spin mb-2" />
                  <span className="text-yellow-500">Preparing...</span>
                </div>
              ) : (
                <span className="text-cyan-400">{Math.round(safeProgress)}%</span>
              )}
            </div>
          </div>

          {/* 상세 정보: 조건부 렌더링 */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Speed</p>
              <p className="font-mono font-bold text-cyan-300">
                {isWaitingForSender ? (
                  <span className="text-yellow-500">Initializing...</span>
                ) : (
                  `${formatBytes(progressData.speed)}/s`
                )}
              </p>
            </div>
            <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Received</p>
              <p className="font-mono text-gray-300">
                {isWaitingForSender ? (
                  <span className="text-yellow-500">Waiting...</span>
                ) : (
                  formatBytes(progressData.bytesTransferred)
                )}
              </p>
            </div>
            <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Total</p>
              <p className="font-mono text-gray-300">
                {manifest ? formatBytes(manifest.totalSize) : '-'}
              </p>
            </div>
          </div>
          
          {/* 상태 메시지 */}
          <p className="text-gray-500 text-sm animate-pulse">
            {isWaitingForSender
              ? 'Allocating space & establishing connection...'
              : 'Downloading directly to your device...'}
          </p>
        </div>
      )}

      {/* 5. DONE */}
      {status === 'DONE' && (
        <div className="text-center p-8 bg-green-900/20 rounded-3xl border border-green-500/30 w-full">
          <FileCheck className="w-24 h-24 text-green-500 mx-auto mb-6" />
          <h2 className="text-3xl font-bold text-white mb-2">Download Complete!</h2>
          <p className="text-gray-300 mb-8">
            {manifest?.totalFiles === 1 ? 'File saved to your selected location.' : 'Files saved to your selected folder.'}
          </p>
          {actualSize > 0 && (
            <p className="text-gray-400 text-sm mb-6">
              Total size: {(actualSize / (1024 * 1024)).toFixed(2)} MB
            </p>
          )}
          <button 
            onClick={() => window.location.reload()}
            className="bg-cyan-600 text-white px-8 py-3 rounded-full font-bold hover:bg-cyan-500 transition-colors"
          >
            Receive Another
          </button>
        </div>
      )}

      {/* 6. QUEUED - 🚀 [Multi-Receiver] 대기열 상태 */}
      {status === 'QUEUED' && (
        <div className="text-center p-8 bg-cyan-900/20 rounded-3xl border border-cyan-500/30 w-full">
          <div className="relative w-20 h-20 mx-auto mb-6">
            <Loader2 className="w-full h-full text-cyan-500 animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-lg font-bold text-white">#{queuePosition}</span>
            </div>
          </div>
          <h2 className="text-2xl font-bold mb-2 text-white">In Queue</h2>
          <p className="text-gray-300 mb-4">{queueMessage || 'Transfer in progress. You will receive the file shortly.'}</p>
          
          <div className="bg-black/40 p-4 rounded-xl text-left flex gap-3 border border-cyan-500/20 mb-4">
            <Archive className="w-6 h-6 text-cyan-500 flex-shrink-0" />
            <div className="text-sm text-gray-300">
              <p className="font-bold text-white mb-1">Your download will start automatically</p>
              <p>Another receiver is currently downloading. Please wait for the current transfer to complete.</p>
            </div>
          </div>
          
          <p className="text-gray-500 text-sm animate-pulse">
            Waiting for current transfer to finish...
          </p>
        </div>
      )}

      {/* 7. ROOM_FULL - 🚨 [추가] 방이 꽉 찼을 때의 대기 상태 */}
      {status === 'ROOM_FULL' && (
        <div className="text-center p-8 bg-yellow-900/20 rounded-3xl border border-yellow-500/30 w-full">
          <Loader2 className="w-16 h-16 text-yellow-500 animate-spin mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2 text-white">Room Occupied</h2>
          <p className="text-gray-300 mb-6">{errorMsg}</p>
          <div className="flex flex-col gap-3">
            <button
              onClick={() => window.location.reload()}
              className="bg-yellow-600 text-white px-6 py-3 rounded-full hover:bg-yellow-500 flex items-center gap-2 mx-auto"
            >
              <RefreshCw size={18} /> Try Again
            </button>
            <p className="text-gray-400 text-sm">
              Or wait a few moments and try again
            </p>
          </div>
        </div>
      )}

      {/* 8. ERROR */}
      {status === 'ERROR' && (
        <div className="text-center p-8 bg-red-900/20 rounded-3xl border border-red-500/30 w-full">
          <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2 text-white">Connection Failed</h2>
          <p className="text-gray-300 mb-6">{errorMsg}</p>
          <button
            onClick={() => window.location.reload()}
            className="bg-gray-800 text-white px-6 py-3 rounded-full hover:bg-gray-700 flex items-center gap-2 mx-auto"
          >
            <RefreshCw size={18} /> Retry
          </button>
        </div>
      )}
    </div>
  );
};

export default ReceiverView;