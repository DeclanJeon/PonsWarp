import React, { useState, useEffect, useRef } from 'react';
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
  const [status, setStatus] = useState<'SCANNING' | 'CONNECTING' | 'WAITING' | 'RECEIVING' | 'DONE' | 'ERROR'>('SCANNING');
  const [manifest, setManifest] = useState<any>(null);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [actualSize, setActualSize] = useState<number>(0);
  const [processMsg, setProcessMsg] = useState('Getting file ready...');
  const [progressData, setProgressData] = useState({ progress: 0, speed: 0, bytesTransferred: 0, totalBytes: 0 });
  
  // 🚨 [추가] 연결 타임아웃 관리용 Ref
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (autoRoomId) handleJoin(autoRoomId);

    transferService.on('metadata', (m) => {
      clearTimeout(connectionTimeoutRef.current!); // 메타데이터 받으면 타임아웃 해제
      setManifest(m);
      setStatus('WAITING');
    });
    
    transferService.on('progress', (p: any) => {
      const val = typeof p === 'object' ? p.progress : p;
      setProgress(isNaN(val) ? 0 : val);
      
      // 속도 정보 업데이트
      if (typeof p === 'object' && p.speed !== undefined) {
        setProgressData({
          progress: p.progress || 0,
          speed: p.speed || 0,
          bytesTransferred: p.bytesTransferred || 0,
          totalBytes: p.totalBytes || 0
        });
      }
    });

    transferService.on('complete', (payload: any) => {
      console.log('[ReceiverView] Transfer Complete.', payload);
      if (payload && payload.actualSize) {
        setActualSize(payload.actualSize);
      }
      setStatus('DONE');
    });
    
    transferService.on('error', (e) => {
      console.error('[ReceiverView] Error:', e);
      clearTimeout(connectionTimeoutRef.current!); // 에러 발생 시 타임아웃 해제
      
      let msg = typeof e === 'string' ? e : 'Unknown Error';
      // 사용자 친화적 메시지 변환
      if (msg.includes('Room full')) msg = 'Room is full. The sender might be connected to someone else.';
      if (msg.includes('closed')) return; // 단순 종료는 무시

      setErrorMsg(msg);
      setStatus('ERROR');
    });

    return () => {
      transferService.cleanup();
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    };
  }, [autoRoomId]);

  const handleJoin = async (id: string) => {
    if (!id || id.length < 6) return;
    
    setStatus('CONNECTING');
    setErrorMsg('');
    
    // 🚨 [핵심] 15초 연결 타임아웃 설정
    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    connectionTimeoutRef.current = setTimeout(() => {
        if (status !== 'WAITING' && status !== 'RECEIVING') {
            setErrorMsg('Connection timed out. Sender may be offline or firewall is blocking.');
            setStatus('ERROR');
            transferService.cleanup();
        }
    }, CONNECTION_TIMEOUT_MS);

    try {
      await transferService.initReceiver(id.toUpperCase());
    } catch (e) {
      setErrorMsg('Failed to initialize connection');
      setStatus('ERROR');
    }
  };

  /**
   * 🚀 [핵심] 사용자가 "Start Download"를 누르면
   * 저장 위치를 확보하고(또는 스트림을 열고) 전송을 시작함
   */
  const startDirectDownload = async () => {
    if (!manifest) return;

    try {
      setProcessMsg('Initializing download...');
      
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
      
    } catch (e: any) {
      if (e.name === 'AbortError') {
        // 사용자가 폴더 선택 취소함
        console.log('User cancelled folder selection');
        return;
      }
      setErrorMsg('Failed to initialize download: ' + e.message);
      setStatus('ERROR');
    }
  };

  const safeProgress = isNaN(progress) || progress < 0 ? 0 : progress;
  const strokeDashoffset = 283 - (283 * safeProgress) / 100;

  return (
    <div className="flex flex-col items-center justify-center h-full w-full max-w-md mx-auto p-6">
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
            <div className="mb-4 p-3 bg-red-900/50 border border-red-500/50 rounded-lg text-sm text-red-200 flex items-center gap-2">
              <AlertCircle size={16} />
              {errorMsg}
            </div>
          )}

          <button
            onClick={startDirectDownload}
            className="bg-white text-black px-8 py-3 rounded-full font-bold hover:bg-gray-200 flex items-center gap-2 mx-auto transition-colors"
          >
            <Download size={20} />
            Start Download
          </button>
        </div>
      )}

      {status === 'RECEIVING' && (
        <div className="text-center w-full">
          <h3 className="text-xl font-bold mb-2">Receiving Data</h3>
          <p className="text-cyan-400 mb-6 truncate px-4">{manifest?.rootName || 'Downloading files...'}</p>
          
          <div className="relative w-48 h-48 mx-auto mb-6">
             <svg className="w-full h-full" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="45" fill="none" stroke="#1e293b" strokeWidth="8" />
                <circle
                  cx="50" cy="50" r="45" fill="none" stroke="#06b6d4" strokeWidth="8"
                  strokeDasharray="283"
                  strokeDashoffset={isNaN(strokeDashoffset) ? 283 : strokeDashoffset}
                  transform="rotate(-90 50 50)"
                  className="transition-all duration-200"
                />
             </svg>
             <div className="absolute inset-0 flex items-center justify-center text-3xl font-bold">
               {Math.round(safeProgress)}%
             </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-6">
             <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
               <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Speed</p>
               <p className="font-mono font-bold text-cyan-300">{formatBytes(progressData.speed)}/s</p>
             </div>
             <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
               <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Received</p>
               <p className="font-mono text-gray-300">{formatBytes(progressData.bytesTransferred)}</p>
             </div>
             <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
               <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Total</p>
               <p className="font-mono text-gray-300">{formatBytes(progressData.totalBytes)}</p>
             </div>
          </div>
          
          <p className="text-gray-500 text-sm">Downloading directly to your device...</p>
        </div>
      )}

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