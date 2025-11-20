import React, { useState, useEffect } from 'react';
import { Scan, Download, Loader2, Archive, AlertCircle, CheckCircle, FileCheck } from 'lucide-react';
import { transferService } from '../services/webRTCService';
import streamSaver from 'streamsaver';
import * as fflate from 'fflate';
import { ReceiverStatus } from '../types';

// StreamSaver 초기화 (MessageChannel 오류 해결)
try {
  if ('serviceWorker' in navigator && 'MessageChannel' in window) {
    streamSaver.mitm = 'https://jimmywarting.github.io/StreamSaver.js/mitm.html?version=2.0.0';
    const originalCreateWriteStream = streamSaver.createWriteStream.bind(streamSaver);
    (streamSaver as any).createWriteStream = function(filename: string, options?: any) {
      const channel = new MessageChannel();
      const enhancedOptions = { ...options, channel: channel };
      try {
        return originalCreateWriteStream(filename, enhancedOptions);
      } catch (error) {
        return originalCreateWriteStream(filename, options);
      }
    };
  }
} catch (error) {
  console.error('[StreamSaver] Initialization error:', error);
}

interface ReceiverViewProps {
  autoRoomId?: string | null;
}

const ReceiverView: React.FC<ReceiverViewProps> = ({ autoRoomId }) => {
  const [roomId, setRoomId] = useState(autoRoomId || '');
  const [status, setStatus] = useState<ReceiverStatus>('SCANNING');
  const [manifest, setManifest] = useState<any>(null);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [actualSize, setActualSize] = useState<number>(0);
  const [processMsg, setProcessMsg] = useState('Getting file ready...');

  useEffect(() => {
    if (autoRoomId) {
      handleJoin(autoRoomId);
    }

    transferService.on('metadata', (m) => {
      setManifest(m);
      setStatus('RECEIVING');
    });
    
    transferService.on('progress', (p: any) => {
        const val = typeof p === 'object' ? p.progress : p;
        setProgress(isNaN(val) ? 0 : val);
    });

    transferService.on('complete', (payload: any) => {
        if (payload && payload.actualSize) {
            setActualSize(payload.actualSize);
        }
        setStatus('DONE');
    });
    
    transferService.on('error', (e) => {
        const msg = typeof e === 'string' ? e : 'Unknown Error';
        if (!msg.includes('closed gracefully')) {
            setErrorMsg(msg);
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

  const downloadWithStreamSaver = async (file: File, fileName: string, size: number) => {
    try {
        // 로컬 mitm.html을 사용하므로 기본 createWriteStream으로 충분합니다.
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
            
            if (writtenTotal % (50 * 1024 * 1024) === 0) {
                  const pct = Math.round((writtenTotal / total) * 100);
                  setProcessMsg(`Saving large file... ${pct}%`);
            }
        }
        
        await writer.close();
        console.log('[Download] StreamSaver completed');
    } catch (streamError) {
        console.error('[Download] StreamSaver failed:', streamError);
        // 폴백: 에러 발생 시 일반 다운로드 시도 (메모리 부족 위험 있음)
        throw new Error('StreamSaver failed. Browser extension might be interfering.');
    }
  };

  // [P2P] 로컬 저장 로직 (복원됨)
  const handleDownload = async () => {
    if (!manifest) return;
    setStatus('PROCESSING');
    setProcessMsg('Accessing internal storage...');

    try {
      const root = await navigator.storage.getDirectory();
      const transferDir = await root.getDirectoryHandle(manifest.transferId);

      // 1. 단일 파일
      if (manifest.totalFiles === 1) {
        const fileNode = manifest.files[0];
        const finalSize = actualSize > 0 ? actualSize : fileNode.size;
        setProcessMsg(`Writing ${fileNode.name} to disk...`);

        const fileHandle = await getFileHandleFromPath(transferDir, fileNode.path);
        const file = await fileHandle.getFile();
        const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024 * 1024;

        if (file.size < LARGE_FILE_THRESHOLD) {
            const url = URL.createObjectURL(file);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileNode.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } else {
            await downloadWithStreamSaver(file, fileNode.name, finalSize);
        }
      }
      // 2. ZIP 다운로드
      else {
        setProcessMsg('Compressing files to ZIP...');
        const zipChunks: Uint8Array[] = [];
        const zip = new fflate.Zip((err, dat, final) => {
            if (err) throw err;
            if (dat) zipChunks.push(dat);
            if (final) {
              const zipBlob = new Blob(zipChunks as BlobPart[], { type: 'application/zip' });
              const url = URL.createObjectURL(zipBlob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${manifest.rootName}.zip`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }
        });

        const processDirectory = async (dirHandle: FileSystemDirectoryHandle, pathPrefix: string) => {
            // @ts-ignore
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

      setStatus('SAVED');

    } catch (e: any) {
      console.error('Download failed', e);
      setErrorMsg('Save failed: ' + e.message);
      setStatus('DONE');
    }
  };

  const safeProgress = isNaN(progress) || progress < 0 ? 0 : progress;
  const strokeDashoffset = 283 - (283 * safeProgress) / 100;

  return (
    <div className="flex flex-col items-center justify-center h-full w-full max-w-md mx-auto p-6">
      {/* 1. SCANNING */}
      {status === 'SCANNING' && (
        <div className="bg-black/80 p-8 rounded-3xl border border-gray-800 text-center w-full">
          <Scan className="w-16 h-16 text-cyan-500 mx-auto mb-4 animate-pulse" />
          <input value={roomId} onChange={(e) => setRoomId(e.target.value.toUpperCase())} placeholder="ROOM ID" maxLength={6} className="bg-gray-900 border border-gray-700 rounded-xl p-4 text-center text-2xl font-mono text-cyan-400 w-full mb-4 uppercase outline-none focus:border-cyan-500" />
          <button onClick={() => handleJoin(roomId)} className="w-full bg-cyan-600 hover:bg-cyan-500 py-3 rounded-xl font-bold transition-colors">CONNECT</button>
        </div>
      )}

      {/* 2. P2P TRANSFERRING */}
      {(status === 'CONNECTING' || status === 'RECEIVING') && (
        <div className="text-center w-full">
          <h3 className="text-xl font-bold mb-2">{status === 'CONNECTING' ? 'Connecting...' : 'Receiving Data'}</h3>
          <p className="text-cyan-400 mb-6 truncate px-4">{manifest?.rootName || 'Waiting for metadata...'}</p>
          <div className="relative w-48 h-48 mx-auto mb-4">
             <svg className="w-full h-full" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="45" fill="none" stroke="#1e293b" strokeWidth="8" />
                <circle cx="50" cy="50" r="45" fill="none" stroke="#06b6d4" strokeWidth="8" strokeDasharray="283" strokeDashoffset={isNaN(strokeDashoffset) ? 283 : strokeDashoffset} transform="rotate(-90 50 50)" className="transition-all duration-200" />
             </svg>
             <div className="absolute inset-0 flex items-center justify-center text-3xl font-bold">{Math.round(safeProgress)}%</div>
          </div>
          <p className="text-gray-500 text-sm">Saving to Internal Storage...</p>
        </div>
      )}

      {/* 3. P2P DONE */}
      {status === 'DONE' && (
        <div className="bg-green-900/20 p-8 rounded-3xl border border-green-500/30 text-center w-full">
          <Archive className="w-20 h-20 text-green-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-white mb-2">Transfer Complete</h2>
          <p className="text-gray-400 text-sm mb-6">{manifest?.totalFiles} files ready to save.</p>
          <button onClick={handleDownload} className="bg-white text-black px-8 py-3 rounded-full font-bold hover:bg-gray-200 flex items-center gap-2 mx-auto">
            <Download size={20} /> {manifest?.totalFiles === 1 ? 'Save File' : 'Save as ZIP'}
          </button>
        </div>
      )}
      
      {/* 4. PROCESSING */}
      {status === 'PROCESSING' && (
         <div className="text-center">
            <Loader2 className="w-16 h-16 text-cyan-500 animate-spin mx-auto mb-4"/>
            <h2 className="text-xl font-bold">Processing...</h2>
            <p className="text-gray-400 animate-pulse">{processMsg}</p>
         </div>
      )}

      {/* 5. SAVED */}
      {status === 'SAVED' && (
        <div className="text-center p-8 bg-cyan-900/20 rounded-3xl border border-cyan-500/30 w-full">
          <FileCheck className="w-24 h-24 text-cyan-400 mx-auto mb-6" />
          <h2 className="text-3xl font-bold text-white mb-2">File Saved!</h2>
          <p className="text-gray-300 mb-8">Check your <strong>Downloads</strong> folder.</p>
          <button onClick={() => window.location.reload()} className="bg-cyan-600 text-white px-8 py-3 rounded-full font-bold hover:bg-cyan-500 transition-colors">Receive Another</button>
        </div>
      )}

      {/* 6. ERROR */}
      {status === 'ERROR' && (
        <div className="text-center p-8 bg-red-900/20 rounded-3xl border border-red-500/30">
          <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2">Error</h2>
          <p className="text-gray-300 mb-6">{errorMsg}</p>
          <button onClick={() => window.location.reload()} className="bg-gray-800 px-6 py-2 rounded-lg hover:bg-gray-700">Retry</button>
        </div>
      )}
    </div>
  );
};

export default ReceiverView;