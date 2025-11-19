import React, { useState, useEffect } from 'react';
import { Scan, Download, Loader2, Archive, AlertCircle, CheckCircle, FileCheck } from 'lucide-react';
import { transferService } from '../services/webRTCService';
import streamSaver from 'streamsaver';
import * as fflate from 'fflate';

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
    
    transferService.on('error', (e) => { 
        console.error('[ReceiverView] Error:', e);
        setErrorMsg(typeof e === 'string' ? e : 'Unknown Error'); 
        setStatus('ERROR');
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

        const fileHandle = await getFileHandleFromPath(transferDir, fileNode.path);
        const file = await fileHandle.getFile();
        
        const fileStream = streamSaver.createWriteStream(fileNode.name, { size: finalSize });
        const reader = file.stream().getReader();
        const writer = fileStream.getWriter();

        try {
            let writtenTotal = 0;
            const total = finalSize;
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await writer.write(value);
                writtenTotal += value.byteLength;
                
                // 대용량 파일 처리 시 UI 업데이트 (10MB 단위로)
                if (writtenTotal % (10 * 1024 * 1024) === 0) {
                     const pct = Math.round((writtenTotal / total) * 100);
                     setProcessMsg(`Saving to Downloads... ${pct}%`);
                }
            }
            
            // 🚨 여기가 멈추던 곳: 상태 메시지 변경
            console.log('[Download] Stream finished. Closing writer...');
            setProcessMsg('Finalizing file... (Do not close)');
            
            await writer.close();
            console.log('[Download] Writer closed.');
            
        } catch (err) {
            console.error('[Download] Stream error:', err);
            await writer.abort(err);
            throw err;
        }
      } 
      // 2️⃣ ZIP 다운로드 (다중 파일)
      else {
        setProcessMsg('Compressing files to ZIP...');
        const fileStream = streamSaver.createWriteStream(`${manifest.rootName}.zip`);
        const writer = fileStream.getWriter();

        const zip = new fflate.Zip((err, dat, final) => {
          if (err) throw err;
          writer.write(dat);
          if (final) writer.close();
        });

        const processDirectory = async (dirHandle: FileSystemDirectoryHandle, pathPrefix: string) => {
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
      }

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