import React, { useState, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Upload, Folder, File as FileIcon, CheckCircle, Copy, Check, Loader2, FilePlus, AlertTriangle } from 'lucide-react';
import { transferService } from '../services/webRTCService';
import { createManifest, formatBytes } from '../utils/fileUtils';
import { motion } from 'framer-motion';

interface SenderViewProps {
  onComplete: () => void;
}

const SenderView: React.FC<SenderViewProps> = ({ onComplete }) => {
  const [manifest, setManifest] = useState<any>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<'IDLE' | 'WAITING' | 'CONNECTING' | 'TRANSFERRING' | 'REMOTE_PROCESSING' | 'DONE'>('IDLE');
  const [progressData, setProgressData] = useState({ progress: 0, speed: 0, bytesTransferred: 0, totalBytes: 0 });
  
  // 🎯 Input Refs 분리
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    transferService.on('status', (s: any) => {
       if (s === 'CONNECTING') setStatus('CONNECTING');
       if (s === 'TRANSFERRING') setStatus('TRANSFERRING');
    });

    transferService.on('progress', (data: any) => setProgressData(data));
    
    // 🚨 [추가] 데이터 전송은 끝났으나 수신자가 저장 중일 때
    transferService.on('remote-processing', () => {
        setStatus('REMOTE_PROCESSING');
    });

    // 최종 완료 (수신자가 저장까지 마쳤을 때)
    transferService.on('complete', () => setStatus('DONE'));
  }, []);

  // 공통 핸들러 (파일이든 폴더든 로직은 같음)
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
    }
  };

  // 드래그 앤 드롭 핸들러
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const processFiles = async (fileList: FileList) => {
    setStatus('WAITING');
    
    // 1. Manifest 생성
    const { manifest, files } = createManifest(fileList);
    setManifest(manifest);
    
    // 2. Room 생성
    const id = transferService.generateRoomId();
    setRoomId(id);
    setShareLink(`${window.location.origin}/receive/${id}`);
    
    // 3. 서비스 초기화
    try {
      await transferService.initSender(manifest, files, id);
    } catch (error) {
      console.error('Init failed', error);
      setStatus('IDLE');
    }
  };

  const copyToClipboard = async () => {
    if (shareLink) {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full w-full max-w-2xl mx-auto p-6 z-10 relative">
      
      {status === 'IDLE' && (
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full space-y-4"
        >
           {/* 드롭존 영역 */}
           <div 
             onDrop={handleDrop}
             onDragOver={handleDragOver}
             className="border-2 border-dashed border-cyan-500/50 bg-black/40 backdrop-blur-md rounded-3xl p-10 text-center transition-all flex flex-col items-center justify-center min-h-[320px]"
           >
             {/* Hidden Inputs */}
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
               // @ts-ignore
               webkitdirectory="" 
             />

             <div className="mb-8">
                <div className="w-20 h-20 bg-cyan-900/20 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
                    <Upload className="w-10 h-10 text-cyan-400" />
                </div>
                <h2 className="text-3xl font-bold mb-2">Drag & Drop</h2>
                <p className="text-cyan-200/60 text-lg">Files or Folders</p>
             </div>

             {/* 버튼 그룹 */}
             <div className="flex gap-4 w-full max-w-md">
               <button 
                 onClick={() => fileInputRef.current?.click()}
                 className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-white py-4 rounded-xl flex flex-col items-center gap-2 transition-all group"
               >
                 <FilePlus className="w-6 h-6 text-cyan-400 group-hover:scale-110 transition-transform"/>
                 <span className="font-bold">Select Files</span>
               </button>

               <button 
                 onClick={() => folderInputRef.current?.click()}
                 className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-600 text-white py-4 rounded-xl flex flex-col items-center gap-2 transition-all group"
               >
                 <Folder className="w-6 h-6 text-yellow-400 group-hover:scale-110 transition-transform"/>
                 <span className="font-bold">Select Folder</span>
               </button>
             </div>
           </div>
        </motion.div>
      )}

      {status === 'WAITING' && roomId && shareLink && (
        <motion.div className="bg-black/60 backdrop-blur-xl p-8 rounded-3xl border border-cyan-500/30 flex flex-col items-center max-w-md w-full">
          <h3 className="text-xl mb-4 font-bold tracking-widest text-cyan-400">READY TO WARP</h3>
          <div className="bg-white p-4 rounded-xl mb-6 shadow-[0_0_20px_rgba(6,182,212,0.3)]">
            <QRCodeSVG value={shareLink} size={180} />
          </div>
          <p className="text-3xl font-mono font-bold mb-6 tracking-widest">{roomId}</p>
          
          <div className="w-full bg-gray-900/50 p-4 rounded-lg mb-4 text-left border border-gray-700">
             <div className="flex items-center gap-3 mb-2">
               {manifest?.isFolder ? <Folder className="text-yellow-500"/> : <FileIcon className="text-blue-500"/>}
               <span className="font-bold truncate text-lg">{manifest?.rootName}</span>
             </div>
             <p className="text-xs text-gray-400 pl-9">
               {manifest?.totalFiles} files • {formatBytes(manifest?.totalSize || 0)}
             </p>
          </div>

          <div className="flex gap-2 w-full">
            <div className="flex-1 bg-gray-800 rounded px-3 py-2 text-xs text-gray-400 truncate leading-8 font-mono">
              {shareLink}
            </div>
            <button onClick={copyToClipboard} className="bg-cyan-600 hover:bg-cyan-500 text-white p-2 rounded transition-colors">
              {copied ? <Check size={16}/> : <Copy size={16}/>}
            </button>
          </div>
          
          <p className="mt-6 text-sm text-gray-500 flex items-center gap-2">
            <Loader2 className="animate-spin w-4 h-4" />
            Waiting for receiver...
          </p>
        </motion.div>
      )}

      {(status === 'TRANSFERRING' || status === 'CONNECTING') && (
        <div className="w-full space-y-6 max-w-lg">
          <div className="text-center">
             <h2 className="text-2xl font-bold mb-2 animate-pulse">Warping Data...</h2>
             <p className="text-cyan-400 text-2xl font-mono">{progressData.progress.toFixed(1)}%</p>
          </div>
          
          <div className="relative h-4 bg-gray-800 rounded-full overflow-hidden border border-gray-700">
            <motion.div
              className="absolute top-0 left-0 h-full bg-gradient-to-r from-cyan-500 to-purple-600"
              initial={{ width: 0 }}
              animate={{ width: `${progressData.progress}%` }}
            />
          </div>

          <div className="grid grid-cols-3 gap-4 text-center">
             <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
               <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Speed</p>
               <p className="font-mono font-bold text-cyan-300">{formatBytes(progressData.speed)}/s</p>
             </div>
             <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
               <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Sent</p>
               <p className="font-mono text-gray-300">{formatBytes(progressData.bytesTransferred)}</p>
             </div>
             <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
               <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Total</p>
               <p className="font-mono text-gray-300">{formatBytes(progressData.totalBytes)}</p>
             </div>
          </div>
        </div>
      )}

      {/* 🚨 [추가] 수신자 저장 대기 화면 */}
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
            
            <h2 className="text-2xl font-bold text-white mb-2">Sending Completed...</h2>
            <h3 className="text-xl text-yellow-400 font-bold mb-6 animate-pulse">Waiting for Receiver to Save</h3>
            
            <div className="bg-black/40 p-4 rounded-xl text-left flex gap-3 border border-yellow-500/20">
                <AlertTriangle className="w-6 h-6 text-yellow-500 flex-shrink-0" />
                <div className="text-sm text-gray-300">
                    <p className="font-bold text-white mb-1">Do NOT close this window.</p>
                    <p>The receiver is currently saving the files. The connection must remain open until they finish downloading.</p>
                </div>
            </div>
        </motion.div>
      )}

      {status === 'DONE' && (
        <div className="text-center">
          <CheckCircle className="w-24 h-24 text-green-500 mx-auto mb-6" />
          <h2 className="text-3xl font-bold mb-2">Transfer Successful!</h2>
          <p className="text-gray-400 mb-8">The receiver has successfully saved the files.</p>
          <button
            onClick={() => window.location.reload()}
            className="bg-white text-black px-8 py-3 rounded-full font-bold hover:bg-cyan-50 transition-colors"
          >
            Send Another
          </button>
        </div>
      )}
    </div>
  );
};

export default SenderView;