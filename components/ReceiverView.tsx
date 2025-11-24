import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Scan, Download, Loader2, Archive, AlertCircle, CheckCircle, FileCheck, FolderOpen, RefreshCw } from 'lucide-react';
import { transferService } from '../services/webRTCService';
import { CONNECTION_TIMEOUT_MS } from '../constants';
import { DirectFileWriter } from '../services/directFileWriter';
import { BrowserFileWriter } from '../services/browserFileWriter';
import { formatBytes } from '../utils/fileUtils';

interface ReceiverViewProps {
  autoRoomId?: string | null;
}

const ReceiverView: React.FC<ReceiverViewProps> = ({ autoRoomId }) => {
  const [roomId, setRoomId] = useState(autoRoomId || '');
  const [status, setStatus] = useState<'SCANNING' | 'CONNECTING' | 'WAITING' | 'RECEIVING' | 'DONE' | 'ERROR' | 'ROOM_FULL'>('SCANNING');
  const [manifest, setManifest] = useState<any>(null);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [actualSize, setActualSize] = useState<number>(0);
  const [progressData, setProgressData] = useState({ progress: 0, speed: 0, bytesTransferred: 0, totalBytes: 0 });
  
  // 🚨 [추가] 송신자 응답 대기 상태 변수
  const [isWaitingForSender, setIsWaitingForSender] = useState(false);
  
  // 🚨 [추가] 연결 타임아웃 관리용 Ref
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // 🚨 [핵심 수정 1] status의 최신 값을 추적하기 위한 Ref 생성
  // setTimeout과 같은 비동기 클로저 안에서도 항상 최신 상태를 읽을 수 있게 함
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // 🚀 [핵심] 이벤트 핸들러들을 useCallback으로 메모이제이션하여 안정성 확보
  const handleMetadata = useCallback((m: any) => {
    // 🚨 [수정] 메타데이터 수신 시 타임아웃 해제 및 에러 상태 초기화
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    setErrorMsg(''); // 이전 에러 메시지 초기화
    setManifest(m);
    setStatus('WAITING');
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

    // 3. 진행률 데이터 업데이트
    const val = typeof p === 'object' ? p.progress : p;
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

  // 초기화 및 이벤트 리스너 등록 Effect
  useEffect(() => {
    if (autoRoomId) handleJoin(autoRoomId);

    // 리스너 등록
    transferService.on('metadata', handleMetadata);
    transferService.on('remote-started', handleRemoteStarted);
    transferService.on('progress', handleProgress);
    transferService.on('complete', handleComplete);
    transferService.on('error', handleError);
    transferService.on('room-full', handleRoomFull);

    return () => {
      // 🚀 [핵심] 클린업 시 리스너를 명시적으로 제거하여 중복 실행 방지
      transferService.off('metadata', handleMetadata);
      transferService.off('remote-started', handleRemoteStarted);
      transferService.off('progress', handleProgress);
      transferService.off('complete', handleComplete);
      transferService.off('error', handleError);
      transferService.off('room-full', handleRoomFull);
      
      transferService.cleanup();
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    };
  }, [autoRoomId, handleMetadata, handleRemoteStarted, handleProgress, handleComplete, handleError, handleRoomFull, handleJoin]);


  /**
   * 🚀 [핵심] 사용자가 "Start Download"를 누르면
   * 저장 위치를 확보하고(또는 스트림을 열고) 전송을 시작함
   */
  const startDirectDownload = useCallback(async () => {
    if (!manifest) return;

    try {
      // 🚨 [핵심 수정] 다운로드 시작 시 기존 타임아웃 즉시 해제
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      
      setIsWaitingForSender(true);
      setStatus('RECEIVING');
      // 1. 브라우저 감지 및 전략 선택
      const userAgent = navigator.userAgent.toLowerCase();
      const isFirefox = userAgent.includes('firefox');
      const isSafari = userAgent.includes('safari') && !userAgent.includes('chrome');
      const supportsFileSystemAccess = 'showDirectoryPicker' in window;
      
      let writer;

      // 파이어폭스와 사파리는 기본 브라우저 다운로드 사용
      if (isFirefox || isSafari || !supportsFileSystemAccess) {
        console.log('[Receiver] Using BrowserFileWriter (Universal compatibility)');
        writer = new BrowserFileWriter();
      } 
      // Chrome/Edge는 File System Access API 사용 (사용자가 선택 가능)
      else {
        console.log('[Receiver] Using DirectFileWriter (FileSystemAccess API)');
        writer = new DirectFileWriter();
      }

      // 2. 서비스에 Writer 주입
      transferService.setWriter(writer);

      // 3. 수신 시작 (내부적으로 writer.initStorage -> transferService.startReceiving 호출)
      await transferService.startReceiving(manifest);
      
      // 🚨 [추가] 다운로드 시작 후 새로운 타임아웃 설정 (송신자 응답 대기)
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
      if (e.name === 'AbortError') {
        setIsWaitingForSender(false);
        setStatus('WAITING');
        return;
      }
      setErrorMsg('Failed to initialize download: ' + e.message);
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

      {/* 6. ROOM_FULL - 🚨 [추가] 방이 꽉 찼을 때의 대기 상태 */}
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

      {/* 7. ERROR */}
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