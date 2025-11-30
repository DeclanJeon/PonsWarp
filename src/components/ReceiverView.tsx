import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Scan, Download, Loader2, Archive, AlertCircle, CheckCircle, FileCheck, RefreshCw, Radio, Lock } from 'lucide-react';
import { transferService } from '../services/webRTCService';
import { CONNECTION_TIMEOUT_MS } from '../utils/constants';
import { DirectFileWriter } from '../services/directFileWriter';
import { formatBytes } from '../utils/fileUtils';
import { useTransferStore } from '../store/transferStore';

const ReceiverView: React.FC = () => {
  // 전역 상태 사용
  const { roomId, setRoomId, status, setStatus, progress, manifest, setManifest, updateProgress, setEncryptionKey } = useTransferStore();
  
  const [errorMsg, setErrorMsg] = useState('');
  const [actualSize, setActualSize] = useState<number>(0);
  const [progressData, setProgressData] = useState({ progress: 0, speed: 0, bytesTransferred: 0, totalBytes: 0 });
  
  // 🔐 URL에서 암호화 키 추출
  useEffect(() => {
    // URL 해시에서 키 추출
    const hash = window.location.hash;
    if (hash && hash.startsWith('#')) {
      const encryptionKey = hash.substring(1); // # 제거
      setEncryptionKey(encryptionKey);
      console.log('[ReceiverView] 🔐 Encryption key extracted from URL hash');
    }
  }, [setEncryptionKey]);
  
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
  const handleMetadata = useCallback(async (m: any) => {
    // 🚨 [수정] 메타데이터 수신 시 타임아웃 해제 및 에러 상태 초기화
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    setErrorMsg(''); // 이전 에러 메시지 초기화
    setManifest(m);
    
    console.log('[ReceiverView] 📋 Metadata received:', {
      transferId: m.transferId,
      totalSize: m.totalSize,
      totalFiles: m.totalFiles
    });
    
    console.log('[ReceiverView] ✨ No resume data found, starting fresh');
    
    // 🚀 [Multi-Receiver] QUEUED 상태에서 manifest를 다시 받으면 
    // 대기열에서 전송이 시작된 것이므로 RECEIVING으로 전환
    const currentStatus = statusRef.current;
    if (currentStatus === 'QUEUED') {
      console.log('[ReceiverView] Manifest received while QUEUED - transfer starting');
      setQueuePosition(0);
      setQueueMessage('');
      updateProgress({ progress: 0, bytesTransferred: 0, totalBytes: m?.totalSize || 0 });
      setProgressData({ progress: 0, speed: 0, bytesTransferred: 0, totalBytes: m?.totalSize || 0 });
      setStatus('RECEIVING');
      setIsWaitingForSender(false);
    } else if (currentStatus !== 'RECEIVING' && currentStatus !== 'DONE') {
      // 일반적인 경우: WAITING 상태로 전환
      setStatus('WAITING');
    }
  }, [setStatus, updateProgress]);

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
    
    // 2. 상태 강제 동기화
    if (status !== 'RECEIVING') {
      setStatus('RECEIVING');
    }

    // 3. 🚀 [성능 최적화] UI 업데이트 스로틀링
    const now = Date.now();
    const val = typeof p === 'object' ? p.progress : p;
    
    // 100ms가 안 지났고, 완료(100%)가 아니면 업데이트 스킵
    if (now - lastProgressUpdateRef.current < UI_UPDATE_INTERVAL && val < 100) {
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
        totalBytes: p.totalBytes || 0
      });
    }
  }, [status, setStatus, updateProgress]);

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
      
      // 🚀 [추가] 연결 촉구 핑 (Poke) 보내기
      // Socket 연결 직후 Sender에게 "내가 왔으니 연결해라"라고 신호 보냄
      setTimeout(() => {
          const currentStatus = statusRef.current;
          if (currentStatus === 'CONNECTING') {
              console.log('[ReceiverView] 📢 Poking sender to initiate connection...');
              // signalingService를 통해 peer-joined 이벤트를 강제로 다시 발생시키는 효과
              // 또는 join-room을 다시 호출하여 존재감 알림
              transferService.joinRoom(id.toUpperCase());
          }
      }, 2000); // 2초 뒤에도 연결 안되면 실행
      
      // 🚀 [수정] room-users 이벤트 리스너 추가하여 빈 방 상황 감지
      const { signalingService } = await import('../services/signaling');
      
      // room-users 이벤트 리스너
      const handleRoomUsers = (users: string[]) => {
        console.log('[ReceiverView] 🏠 [DEBUG] Room users received:', users);
        
        if (users.length === 0) {
          console.warn('[ReceiverView] ⚠️ [DEBUG] Room is empty! Sender may not be in the room.');
          
          // 5초 후에도 빈 방이면 경고 메시지 표시
          setTimeout(() => {
            if (statusRef.current === 'CONNECTING') {
              setErrorMsg('Sender is not in the room. Please check the room ID or try again.');
              setStatus('ERROR');
            }
          }, 5000);
        }
      };
      
      signalingService.on('room-users', handleRoomUsers);
      
      // 10초 후에 room-users 이벤트 리스너 제거
      setTimeout(() => {
        signalingService.off('room-users', handleRoomUsers);
      }, 10000);
      
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
    updateProgress({ progress: 0, bytesTransferred: 0, totalBytes: manifest?.totalSize || 0 });
    setProgressData({ progress: 0, speed: 0, bytesTransferred: 0, totalBytes: manifest?.totalSize || 0 });
    // 상태 전환
    setStatus('RECEIVING');
    setIsWaitingForSender(false);
  }, [manifest, updateProgress, setStatus]);

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

  // 🚀 [핵심 수정] 방 참여 Effect (roomId가 있을 때 한 번만 실행)
  useEffect(() => {
    if (roomId && !isInitializedRef.current) {
      isInitializedRef.current = true;
      
      handleJoin(roomId);
    }
  }, [roomId, handleJoin, manifest, progress.bytesTransferred]);

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
      // 🔐 암호화 키를 transferService에 전달
      const { encryptionKeyStr } = useTransferStore.getState();
      await transferService.startReceiving(manifest, encryptionKeyStr);
      console.log('[ReceiverView] ✅ Receiver initialization complete');
      
      // 🚀 [핵심 수정] TRANSFER_READY 전송 후 즉시 상태 확인
      // 송신자의 응답을 기다리지 않고 즉시 전송 시작 가능 여부 확인
      setTimeout(() => {
        if (statusRef.current === 'RECEIVING' && isWaitingForSender) {
          console.log('[ReceiverView] Checking if sender responded...');
          
          // 🚀 [핵심] 추가 대기 없이 즉시 TRANSFER_READY 재전송
          try {
            console.log('[ReceiverView] Resending TRANSFER_READY to ensure sender receives it');
            // webRTCService의 sendControlMessage 메서드 사용
            transferService.sendControlMessage(JSON.stringify({ type: 'TRANSFER_READY' }));
          } catch (e) {
            console.error('[ReceiverView] Failed to resend TRANSFER_READY:', e);
          }
        }
      }, 1000); // 1초 후 재전송 시도
      
      // 다운로드 시작 후 새로운 타임아웃 설정 (송신자 응답 대기)
      connectionTimeoutRef.current = setTimeout(() => {
        if (statusRef.current === 'RECEIVING' && isWaitingForSender) {
          console.warn('[ReceiverView] Download start timeout - no response from sender');
          setErrorMsg('Sender did not respond. Please try again.');
          setStatus('ERROR');
          setIsWaitingForSender(false);
          transferService.cleanup();
        }
      }, 15000); // 15초로 타임아웃 증가
      
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

  const safeProgress = isNaN(progress.progress) || progress.progress < 0 ? 0 : progress.progress;
  const strokeDashoffset = 283 - (283 * safeProgress) / 100;
  
  // Glass Panel 스타일
  const glassPanelClass = "bg-black/30 backdrop-blur-2xl border border-white/10 rounded-[2rem] p-10 shadow-[0_0_40px_rgba(0,0,0,0.5)] w-full max-w-md relative overflow-hidden group";
  const glowEffectClass = "absolute inset-0 bg-gradient-to-br from-purple-500/10 to-cyan-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none";

  return (
    <div className="flex flex-col items-center justify-center w-full">
      
      {/* 1. IDLE / INPUT */}
      {status === 'IDLE' && (
        <div className={glassPanelClass}>
          <div className={glowEffectClass} />
          <div className="text-center relative z-10">
            <div className="w-20 h-20 mx-auto mb-6 bg-white/5 rounded-full flex items-center justify-center animate-pulse border border-white/10">
              <Scan className="w-10 h-10 text-cyan-400" />
            </div>
            <h2 className="text-2xl font-bold mb-6 tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-purple-300">
              ENTER WARP KEY
            </h2>
            <div className="relative">
              <input
                value={roomId || ''}
                onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                placeholder="######"
                maxLength={6}
                className="w-full bg-black/40 border-2 border-white/10 rounded-xl p-4 text-center text-3xl font-mono text-cyan-400 tracking-[0.5em] outline-none focus:border-cyan-500/50 focus:shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all placeholder-white/10"
              />
              <div className="absolute inset-0 pointer-events-none border border-cyan-500/20 rounded-xl mix-blend-overlay" />
            </div>
            <button 
              onClick={() => handleJoin(roomId!)} 
              disabled={!roomId || roomId.length < 6}
              className="mt-6 w-full bg-white text-black py-4 rounded-xl font-bold tracking-widest hover:bg-cyan-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ESTABLISH LINK
            </button>
          </div>
        </div>
      )}

      {/* 2. CONNECTING */}
      {status === 'CONNECTING' && (
        <div className="text-center">
          <div className="relative w-32 h-32 mx-auto mb-8">
            <div className="absolute inset-0 border-4 border-t-cyan-500 border-r-transparent border-b-purple-500 border-l-transparent rounded-full animate-spin" />
            <div className="absolute inset-4 border-4 border-t-transparent border-r-white/30 border-b-transparent border-l-white/30 rounded-full animate-spin-reverse" />
            <Radio className="absolute inset-0 m-auto text-cyan-400 animate-pulse" size={32} />
          </div>
          <h3 className="text-2xl font-bold mb-2 tracking-widest">SEARCHING FREQUENCY...</h3>
          <p className="text-cyan-400/60 font-mono">Waiting for sender signal</p>
        </div>
      )}

      {/* 3. WAITING */}
      {status === 'WAITING' && (
        <div className={glassPanelClass}>
          <div className={glowEffectClass} />
          <div className="text-center relative z-10">
            <Archive className="w-20 h-20 text-cyan-400 mx-auto mb-6 drop-shadow-[0_0_15px_rgba(6,182,212,0.5)]" />
            <h2 className="text-3xl font-bold text-white mb-2 tracking-wider">INCOMING TRANSMISSION</h2>
            
            {/* 🔐 암호화 활성화 표시 */}
            <div className="flex items-center gap-2 mb-4 bg-green-900/20 px-3 py-2 rounded-lg border border-green-500/30">
              <Lock className="w-4 h-4 text-green-400" />
              <span className="text-sm text-green-400">End-to-End Encrypted</span>
            </div>
            
            <p className="text-cyan-400/80 text-sm mb-6 font-mono">
              {manifest?.totalFiles === 1 ? manifest?.files[0]?.name : `${manifest?.totalFiles} files`}
            </p>
            <p className="text-gray-400 text-sm mb-8">
              Size: {manifest ? (manifest.totalSize / (1024 * 1024)).toFixed(2) : '0'} MB
            </p>
            
            {errorMsg && (
              <div className="mb-4 p-3 bg-red-900/30 border border-red-500/30 rounded-lg text-sm text-red-200 flex items-center gap-2 text-left backdrop-blur-sm">
                <AlertCircle size={16} className="flex-shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            <button
              onClick={startDirectDownload}
              className="bg-white/10 border border-white/20 text-white px-8 py-3 rounded-full hover:bg-white/20 transition-all flex items-center gap-2 mx-auto w-full justify-center font-bold tracking-wider"
            >
              <Download size={20} />
              MATERIALIZE
            </button>
          </div>
        </div>
      )}


      {/* 4. RECEIVING (REVERSE WARP VISIBLE) */}
      {status === 'RECEIVING' && (
        <div className="text-center w-full max-w-2xl relative">
          {/* 중앙 HUD 스타일 프로그레스 */}
          <div className="relative w-64 h-64 mx-auto mb-8">
            {/* 배경 링 */}
            <svg className="w-full h-full rotate-[-90deg]" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />
              {/* 진행 링 */}
              <circle
                cx="50" cy="50" r="45" fill="none"
                stroke="url(#gradient)"
                strokeWidth="4"
                strokeDasharray="283"
                strokeDashoffset={isNaN(strokeDashoffset) ? 283 : strokeDashoffset}
                className="transition-all duration-300 ease-out drop-shadow-[0_0_10px_rgba(6,182,212,0.8)]"
              />
              <defs>
                <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="0%">
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
              <span className="text-xs text-cyan-300/80 font-mono mt-2 tracking-widest">INCOMING STREAM</span>
            </div>
          </div>

          {/* 하단 정보 패널 (투명) */}
          <div className="grid grid-cols-2 gap-4 bg-black/20 backdrop-blur-md rounded-2xl p-6 border border-white/5">
            <div className="text-left">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Download Speed</p>
              <p className="font-mono text-xl text-cyan-400 font-bold">{formatBytes(progressData.speed)}/s</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Data Received</p>
              <p className="font-mono text-xl text-white">{formatBytes(progressData.bytesTransferred)}</p>
            </div>
          </div>

          <p className="mt-8 text-cyan-500/50 text-sm animate-pulse tracking-[0.2em] font-mono">
            &lt;&lt;&lt; RECEIVING MATTER STREAM &lt;&lt;&lt;
          </p>
        </div>
      )}

      {/* 5. DONE */}
      {status === 'DONE' && (
        <div className={glassPanelClass}>
          <div className="text-center relative z-10">
            <CheckCircle className="w-20 h-20 text-green-400 mx-auto mb-6 drop-shadow-[0_0_15px_rgba(74,222,128,0.5)]" />
            <h2 className="text-3xl font-bold text-white mb-2 tracking-wider">MATERIALIZED</h2>
            <p className="text-gray-400 mb-8">File reconstruction complete.</p>
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
        </div>
      )}

      {/* 6. ERROR */}
      {status === 'ERROR' && (
        <div className={glassPanelClass}>
          <div className="text-center relative z-10">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4 drop-shadow-[0_0_15px_rgba(239,68,68,0.5)]" />
            <h2 className="text-2xl font-bold mb-2 text-white tracking-wider">CONNECTION FAILED</h2>
            <p className="text-gray-300 mb-6">{errorMsg}</p>
            <button
              onClick={() => window.location.reload()}
              className="bg-white/10 border border-white/20 text-white px-6 py-3 rounded-full hover:bg-white/20 flex items-center gap-2 mx-auto transition-all"
            >
              <RefreshCw size={18} /> Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReceiverView;