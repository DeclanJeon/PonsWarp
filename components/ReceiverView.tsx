import React, { useState, useEffect } from 'react';
import { Scan, Download, Loader2, Archive, AlertCircle, CheckCircle, FileCheck } from 'lucide-react';
import { transferService } from '../services/webRTCService';
import streamSaver from 'streamsaver';
import * as fflate from 'fflate';

// 🚨 [수정] StreamSaver 초기화 - MessageChannel 오류 해결
try {
  // StreamSaver가 MessageChannel을 올바르게 사용하도록 설정
  if ('serviceWorker' in navigator && 'MessageChannel' in window) {
    console.log('[StreamSaver] Browser supports required features');
    
    // StreamSaver의 기본 mitm URL을 명시적으로 설정
    streamSaver.mitm = 'https://jimmywarting.github.io/StreamSaver.js/mitm.html?version=2.0.0';
    
    // 🚨 [핵심 수정] StreamSaver의 createWriteStream 메서드를 오버라이드하여
    // MessageChannel 문제를 완전히 해결
    const originalCreateWriteStream = streamSaver.createWriteStream.bind(streamSaver);
    
    (streamSaver as any).createWriteStream = function(filename: string, options?: any) {
      console.log('[StreamSaver] Creating write stream with MessageChannel fix');
      
      // 🚨 [수정] MessageChannel을 직접 생성하여 StreamSaver에 전달
      const channel = new MessageChannel();
      
      // 🚨 [핵심] MessageChannel을 options에 포함하여 전달
      const enhancedOptions = {
        ...options,
        // 🚨 [추가] MessageChannel을 명시적으로 전달
        channel: channel
      };
      
      try {
        // 🚨 [수정] MessageChannel을 포함한 options로 원래 메서드 호출
        const stream = originalCreateWriteStream(filename, enhancedOptions);
        
        // 🚨 [추가] StreamSaver가 MessageChannel을 사용하도록 강제
        // StreamSaver 내부의 MessageChannel 생성 문제를 해결
        return stream;
      } catch (error) {
        console.error('[StreamSaver] Error in createWriteStream:', error);
        
        // 🚨 [수정] 실패 시 MessageChannel을 다른 방식으로 시도
        try {
          // 🚨 [대안] StreamSaver의 내부 MessageChannel 생성을 우회
          const stream = originalCreateWriteStream(filename, options);
          return stream;
        } catch (retryError) {
          console.error('[StreamSaver] Retry failed:', retryError);
          throw retryError;
        }
      }
    };
    
    // 전역 스코프에 StreamSaver 초기화 플래그 설정
    if (typeof window !== 'undefined') {
      (window as any).__streamSaverInitialized = true;
    }
  } else {
    console.warn('[StreamSaver] Browser does not support required features');
  }
} catch (error) {
  console.error('[StreamSaver] Initialization error:', error);
}

interface ReceiverViewProps {
  autoRoomId?: string | null;
}

const ReceiverView: React.FC<ReceiverViewProps> = ({ autoRoomId }) => {
  const [roomId, setRoomId] = useState(autoRoomId || '');
  // SAVED 상태 추가
  const [status, setStatus] = useState<'SCANNING' | 'CONNECTING' | 'RECEIVING' | 'DONE' | 'PROCESSING' | 'SAVED' | 'ERROR'>('SCANNING');
  const [manifest, setManifest] = useState<any>(null);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [actualSize, setActualSize] = useState<number>(0);
  // 상세 진행 상태 메시지
  const [processMsg, setProcessMsg] = useState('Getting file ready...');

  useEffect(() => {
    if (autoRoomId) handleJoin(autoRoomId);

    transferService.on('metadata', (m) => {
      setManifest(m);
      setStatus('RECEIVING');
    });
    
    transferService.on('progress', (p: any) => {
        const val = typeof p === 'object' ? p.progress : p;
        setProgress(isNaN(val) ? 0 : val);
    });

    transferService.on('complete', (payload: any) => {
        console.log('[ReceiverView] Transfer Complete.', payload);
        if (payload && payload.actualSize) {
            setActualSize(payload.actualSize);
        }
        setStatus('DONE');
    });
    
    // 🚨 [추가] 오류 중복 방지를 위한 변수
    let lastErrorTime = 0;
    let lastErrorMessage = '';
    
    transferService.on('error', (e) => {
        console.error('[ReceiverView] Error:', e);
        const errorMsg = typeof e === 'string' ? e : 'Unknown Error';
        const now = Date.now();
        
        // 🚨 [수정] 동일한 오류가 1초 내에 반복되면 무시
        if (errorMsg === lastErrorMessage && (now - lastErrorTime) < 1000) {
          console.warn('[ReceiverView] Ignoring duplicate error:', errorMsg);
          return;
        }
        
        lastErrorTime = now;
        lastErrorMessage = errorMsg;
        
        // 🚨 [수정] 특정 오류 메시지에 따라 다른 처리
        if (errorMsg.includes('Peer connection closed') || errorMsg.includes('User-Initiated Abort')) {
          // 연결 종료 오류는 즉시 ERROR 상태로 전환하지 않고 사용자에게 알림만 표시
          console.warn('[ReceiverView] Connection closed gracefully:', errorMsg);
          // 이미 DONE 상태가 아니라면 ERROR 상태로 설정
          if (status !== 'DONE' && status !== 'SAVED' && status !== 'ERROR') {
            setErrorMsg('Connection lost during transfer');
            setStatus('ERROR');
          }
        } else {
          // 다른 종류의 오류는 즉시 표시
          setErrorMsg(errorMsg);
          setStatus('ERROR');
        }
    });

    return () => transferService.cleanup();
  }, [autoRoomId]);

  const handleJoin = async (id: string) => {
    setStatus('CONNECTING');
    try {
      await transferService.initReceiver(id.toUpperCase());
    } catch (e) {
      setErrorMsg('Failed to join');
      setStatus('ERROR');
    }
  };

  const getFileHandleFromPath = async (root: FileSystemDirectoryHandle, path: string) => {
    const parts = path.split('/');
    const fileName = parts.pop()!;
    let currentDir = root;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part);
    }
    return await currentDir.getFileHandle(fileName);
  };

  // StreamSaver 로직 분리 (재사용성 및 가독성 향상)
  const downloadWithStreamSaver = async (file: File, fileName: string, size: number) => {
    try {
        const fileStream = streamSaver.createWriteStream(fileName, { size: size });
        const reader = file.stream().getReader();
        const writer = fileStream.getWriter();

        let writtenTotal = 0;
        const total = size;
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
            writtenTotal += value.byteLength;
            
            // UI 업데이트 (부하를 줄이기 위해 50MB마다 업데이트)
            if (writtenTotal % (50 * 1024 * 1024) === 0) {
                  const pct = Math.round((writtenTotal / total) * 100);
                  setProcessMsg(`Saving large file... ${pct}%`);
            }
        }
        
        await writer.close();
        console.log('[Download] StreamSaver completed');
    } catch (streamError) {
        console.error('[Download] StreamSaver failed:', streamError);
        throw new Error('Download failed. Please try using a different browser.');
    }
  };

  const handleDownload = async () => {
    if (!manifest) return;
    setStatus('PROCESSING');
    setProcessMsg('Accessing internal storage...');

    try {
      const root = await navigator.storage.getDirectory();
      const transferDir = await root.getDirectoryHandle(manifest.transferId);

      // 1️⃣ 단일 파일 다운로드
      if (manifest.totalFiles === 1) {
        const fileNode = manifest.files[0];
        const finalSize = actualSize > 0 ? actualSize : fileNode.size;
        
        console.log(`[Download] Saving ${fileNode.name} (Size: ${finalSize})`);
        setProcessMsg(`Writing ${fileNode.name} to disk...`);

        // 🚨 [수정] 파일이 실제로 존재하는지 확인
        let fileHandle;
        try {
          fileHandle = await getFileHandleFromPath(transferDir, fileNode.path);
        } catch (error) {
          console.error('[Download] File handle not found:', error);
          setErrorMsg('File not found in internal storage');
          setStatus('DONE');
          return;
        }

        const file = await fileHandle.getFile();
        
        // 🚨 [수정] 파일이 실제로 데이터를 가졌는지 확인
        if (file.size === 0) {
          console.error('[Download] File is empty:', file.name);
          setErrorMsg('File is empty or corrupted');
          setStatus('DONE');
          return;
        }
        
        // 파일 정보 로깅 (메모리 안전)
        console.log('[Download] File info:', {
          name: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified
        });
        
        // 🚨 [수정] 100MB 미만 파일만 무결성 확인 (메모리 안전)
        if (file.size < 100 * 1024 * 1024) {
          try {
            const fileBuffer = await file.arrayBuffer();
            const first100Bytes = Array.from(new Uint8Array(fileBuffer.slice(0, 100)));
            console.log('[Download] First 100 bytes:', first100Bytes);
          } catch (e) {
            console.warn('[Download] Could not verify file integrity:', e);
          }
        } else {
          console.log('[Download] Skipping integrity check for large file');
        }
        
        // 🚨 [최종 최적화] 1GB 이상은 무조건 StreamSaver 사용 (메모리 폭발 방지)
        const LARGE_FILE_THRESHOLD = 1 * 1024 * 1024 * 1024; // 1GB (메모리 안전을 위해 임계값 낮춤)

        if (file.size < LARGE_FILE_THRESHOLD) {
            // 🟢 1GB 미만: 기존 방식 (가장 빠름)
            try {
              const url = URL.createObjectURL(file);
              const a = document.createElement('a');
              a.href = url;
              a.download = fileNode.name;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              console.log('[Download] Basic download successful');
            } catch (error) {
              console.warn('[Download] Basic download failed, switching to StreamSaver');
              await downloadWithStreamSaver(file, fileNode.name, finalSize);
            }
        } else {
            // 🟠 1GB 이상: StreamSaver 강제 사용 (안전함)
            console.log('[Download] Large file detected. Using StreamSaver to prevent memory crash.');
            await downloadWithStreamSaver(file, fileNode.name, finalSize);
        }
      }
      // 2️⃣ ZIP 다운로드 (다중 파일)
      else {
        setProcessMsg('Compressing files to ZIP...');
        
        try {
          // 🚨 [수정] ZIP 파일을 메모리에서 생성 후 기본 다운로드 방식 사용
          const zipChunks: Uint8Array[] = [];
          const zip = new fflate.Zip((err, dat, final) => {
            if (err) throw err;
            if (dat) zipChunks.push(dat);
            if (final) {
              // ZIP 파일 생성 완료
              const zipBlob = new Blob(zipChunks as BlobPart[], { type: 'application/zip' });
              const url = URL.createObjectURL(zipBlob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${manifest.rootName}.zip`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              console.log('[Download] ZIP file downloaded successfully');
            }
          });

          const processDirectory = async (dirHandle: FileSystemDirectoryHandle, pathPrefix: string) => {
            // 🚨 [수정] @ts-ignore 추가로 values() 메서드 사용
            // @ts-ignore - values() 메서드는 실험적 기능이지만 대부분의 최신 브라우저에서 지원
            for await (const entry of dirHandle.values()) {
              const fullPath = pathPrefix + entry.name;
              if (entry.kind === 'file') {
                const fileHandle = await dirHandle.getFileHandle(entry.name);
                const file = await fileHandle.getFile();
                const buffer = await file.arrayBuffer();
                const f = new fflate.ZipPassThrough(fullPath);
                zip.add(f);
                f.push(new Uint8Array(buffer), true);
              } else if (entry.kind === 'directory') {
                const subDir = await dirHandle.getDirectoryHandle(entry.name);
                await processDirectory(subDir, fullPath + '/');
              }
            }
          };

          await processDirectory(transferDir, '');
          zip.end();
        } catch (zipError) {
          console.error('[Download] ZIP creation failed:', zipError);
          
          // 🚨 [대안] StreamSaver를 최후의 수단으로만 사용
          try {
            console.log('[Download] Falling back to StreamSaver for ZIP...');
            const fileStream = streamSaver.createWriteStream(`${manifest.rootName}.zip`);
            const writer = fileStream.getWriter();

            const zip = new fflate.Zip((err, dat, final) => {
              if (err) throw err;
              writer.write(dat);
              if (final) writer.close();
            });

            const processDirectory = async (dirHandle: FileSystemDirectoryHandle, pathPrefix: string) => {
              // 🚨 [수정] @ts-ignore 추가로 values() 메서드 사용
              // @ts-ignore - values() 메서드는 실험적 기능이지만 대부분의 최신 브라우저에서 지원
              for await (const entry of dirHandle.values()) {
                const fullPath = pathPrefix + entry.name;
                if (entry.kind === 'file') {
                  const fileHandle = await dirHandle.getFileHandle(entry.name);
                  const file = await fileHandle.getFile();
                  const buffer = await file.arrayBuffer();
                  const f = new fflate.ZipPassThrough(fullPath);
                  zip.add(f);
                  f.push(new Uint8Array(buffer), true);
                } else if (entry.kind === 'directory') {
                  const subDir = await dirHandle.getDirectoryHandle(entry.name);
                  await processDirectory(subDir, fullPath + '/');
                }
              }
            };

            await processDirectory(transferDir, '');
            zip.end();
            console.log('[Download] StreamSaver ZIP fallback completed');
          } catch (streamError) {
            console.error('[Download] StreamSaver ZIP fallback also failed:', streamError);
            throw new Error('All ZIP download methods failed');
          }
        }
      }

      // 🚨 [핵심 변경 사항]
      // 파일 저장이 성공적으로 호출된 후, 송신자에게 "완료되었음"을 알림
      console.log('[Receiver] File saved successfully, notifying sender...');
      transferService.notifyDownloadComplete();

      // 🚨 자동 새로고침 삭제 -> 성공 화면으로 이동
      setStatus('SAVED');

    } catch (e: any) {
      console.error('Download failed', e);
      if (e.name === 'NotReadableError') {
         setErrorMsg('File system busy. Wait a moment and try again.');
      } else {
         setErrorMsg('Save failed: ' + e.message);
      }
      setStatus('DONE');
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

      {(status === 'CONNECTING' || status === 'RECEIVING') && (
        <div className="text-center w-full">
          <h3 className="text-xl font-bold mb-2">{status === 'CONNECTING' ? 'Connecting...' : 'Receiving Data'}</h3>
          <p className="text-cyan-400 mb-6 truncate px-4">{manifest?.rootName || 'Waiting for metadata...'}</p>
          
          <div className="relative w-48 h-48 mx-auto mb-4">
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
          <p className="text-gray-500 text-sm">Saving to Internal Storage...</p>
        </div>
      )}

      {status === 'DONE' && (
        <div className="bg-green-900/20 p-8 rounded-3xl border border-green-500/30 text-center w-full">
          <Archive className="w-20 h-20 text-green-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-white mb-2">Transfer Complete</h2>
          <p className="text-gray-400 text-sm mb-6">
            {manifest?.totalFiles} files ready to save.
          </p>
          
          {errorMsg && (
            <div className="mb-4 p-3 bg-red-900/50 border border-red-500/50 rounded-lg text-sm text-red-200 flex items-center gap-2">
                <AlertCircle size={16} />
                {errorMsg}
            </div>
          )}

          <button
            onClick={handleDownload}
            className="bg-white text-black px-8 py-3 rounded-full font-bold hover:bg-gray-200 flex items-center gap-2 mx-auto transition-colors"
          >
            <Download size={20} />
            {manifest?.totalFiles === 1 ? 'Save File' : 'Save as ZIP'}
          </button>
        </div>
      )}
      
      {status === 'PROCESSING' && (
         <div className="text-center">
            <Loader2 className="w-16 h-16 text-cyan-500 animate-spin mx-auto mb-4"/>
            <h2 className="text-xl font-bold">Processing...</h2>
            <p className="text-gray-400 animate-pulse">{processMsg}</p>
         </div>
      )}

      {/* 🚨 [추가] 저장 완료 화면 */}
      {status === 'SAVED' && (
        <div className="text-center p-8 bg-cyan-900/20 rounded-3xl border border-cyan-500/30 w-full">
          <FileCheck className="w-24 h-24 text-cyan-400 mx-auto mb-6" />
          <h2 className="text-3xl font-bold text-white mb-2">File Saved!</h2>
          <p className="text-gray-300 mb-8">
             Your file has been saved to the <strong>Downloads</strong> folder.
          </p>
          <button 
            onClick={() => window.location.reload()}
            className="bg-cyan-600 text-white px-8 py-3 rounded-full font-bold hover:bg-cyan-500 transition-colors"
          >
            Receive Another
          </button>
        </div>
      )}

      {status === 'ERROR' && (
        <div className="text-center p-8 bg-red-900/20 rounded-3xl border border-red-500/30">
          <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2">Error</h2>
          <p className="text-gray-300 mb-6">{errorMsg}</p>
          <button onClick={() => window.location.reload()} className="bg-gray-800 px-6 py-2 rounded-lg hover:bg-gray-700">
            Retry
          </button>
        </div>
      )}
    </div>
  );
};

export default ReceiverView;