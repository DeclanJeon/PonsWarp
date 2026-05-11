import React, { useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Check,
  CloudUpload,
  Copy,
  FileIcon,
  FilePlus,
  Folder,
  Loader2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  completeCloudShare,
  createCloudShare,
  uploadCloudFile,
} from '../services/cloudShareService';
import {
  scanFiles,
  processInputFiles,
  ScannedFile,
} from '../utils/fileScanner';
import { createManifest, formatBytes } from '../utils/fileUtils';
import { TransferManifest } from '../types/types';

type CloudUploadStatus = 'IDLE' | 'PREPARING' | 'UPLOADING' | 'DONE' | 'ERROR';

const MAX_PARALLEL_UPLOADS = 3;
const CLOUD_DROP_MAX_BYTES = 10 * 1024 * 1024 * 1024;

const CloudSenderView: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<CloudUploadStatus>('IDLE');
  const [manifest, setManifest] = useState<TransferManifest | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [fileProgress, setFileProgress] = useState<Record<string, number>>({});

  const uploadedBytes = useMemo(
    () =>
      Object.values(fileProgress).reduce((total, value) => total + value, 0),
    [fileProgress]
  );
  const totalBytes = manifest?.totalSize || 0;
  const progress =
    totalBytes > 0 ? Math.min(100, (uploadedBytes / totalBytes) * 100) : 0;

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    await processScannedFiles(processInputFiles(e.target.files));
    e.target.value = '';
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      await processScannedFiles(await scanFiles(e.dataTransfer.items));
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processScannedFiles(processInputFiles(e.dataTransfer.files));
    }
  };

  const processScannedFiles = async (scannedFiles: ScannedFile[]) => {
    if (scannedFiles.length === 0) return;

    const { manifest: nextManifest } = createManifest(scannedFiles);
    if (nextManifest.totalSize > CLOUD_DROP_MAX_BYTES) {
      setManifest(nextManifest);
      setShareLink(null);
      setExpiresAt(null);
      setCopied(false);
      setFileProgress({});
      setCurrentFile(null);
      setError(
        `Cloud Drop is limited to ${formatBytes(CLOUD_DROP_MAX_BYTES)}. For unlimited transfer, use SEND and keep sender and receiver online together. Otherwise split the files into 10GB batches.`
      );
      setStatus('ERROR');
      return;
    }

    const oversizedFile = scannedFiles.find(
      item => item.file.size > CLOUD_DROP_MAX_BYTES
    );
    if (oversizedFile) {
      setManifest(nextManifest);
      setShareLink(null);
      setExpiresAt(null);
      setCopied(false);
      setFileProgress({});
      setCurrentFile(null);
      setError(
        `${oversizedFile.path} is larger than ${formatBytes(CLOUD_DROP_MAX_BYTES)}. Use direct P2P for unlimited transfer or split the file.`
      );
      setStatus('ERROR');
      return;
    }

    setManifest(nextManifest);
    setShareLink(null);
    setExpiresAt(null);
    setCopied(false);
    setError(null);
    setFileProgress({});
    setStatus('PREPARING');

    try {
      const created = await createCloudShare(
        nextManifest.rootName,
        scannedFiles
      );
      const uploadedIds: string[] = [];
      let nextIndex = 0;

      setStatus('UPLOADING');

      const uploadWorker = async () => {
        while (nextIndex < created.files.length) {
          const index = nextIndex;
          nextIndex += 1;

          const target = created.files[index];
          const source = scannedFiles[index];
          if (!target || !source) continue;

          setCurrentFile(target.path);
          await uploadCloudFile(
            target.uploadUrl,
            source.file,
            progressEvent => {
              setFileProgress(prev => ({
                ...prev,
                [target.id]: progressEvent.loaded,
              }));
            }
          );
          uploadedIds.push(target.id);
        }
      };

      const workerCount = Math.min(MAX_PARALLEL_UPLOADS, created.files.length);
      await Promise.all(Array.from({ length: workerCount }, uploadWorker));

      const completed = await completeCloudShare(created.shareId, uploadedIds);
      setCurrentFile(null);
      setExpiresAt(completed.expiresAt);
      setShareLink(`${window.location.origin}${created.shareUrl}`);
      setStatus('DONE');
    } catch (uploadError: any) {
      setStatus('ERROR');
      setError(uploadError?.message || 'Cloud upload failed');
    }
  };

  const copyToClipboard = async () => {
    if (!shareLink) return;
    await navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const expiryLabel = expiresAt
    ? new Date(expiresAt * 1000).toLocaleString()
    : '24 hours after upload';

  const glassPanelClass =
    'bg-black/40 backdrop-blur-2xl border border-emerald-500/20 rounded-[2rem] shadow-[0_0_40px_rgba(0,0,0,0.3)] overflow-hidden';

  return (
    <div className="flex flex-col items-center justify-center h-full w-full px-4 py-6 md:px-0 z-10 relative">
      <AnimatePresence mode="wait">
        {status === 'IDLE' && (
          <motion.div
            key="cloud-idle"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20, filter: 'blur(10px)' }}
            className={`w-full max-w-2xl p-2 ${glassPanelClass}`}
          >
            <div
              onDragOver={e => e.preventDefault()}
              onDrop={handleDrop}
              className="border-2 border-dashed border-emerald-500/30 rounded-[1.8rem] py-8 px-4 md:py-16 md:px-10 flex flex-col items-center justify-center text-center transition-all hover:border-emerald-400/60 hover:bg-emerald-500/5"
            >
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
                {...({ webkitdirectory: '' } as any)}
              />

              <div className="w-16 h-16 md:w-20 md:h-20 bg-emerald-900/20 rounded-full flex items-center justify-center mb-6 md:mb-8 shadow-[0_0_30px_rgba(16,185,129,0.2)]">
                <CloudUpload className="w-8 h-8 md:w-10 md:h-10 text-emerald-400" />
              </div>

              <h2 className="text-2xl md:text-3xl font-bold mb-3 md:mb-4 brand-font text-white">
                CLOUD DROP
              </h2>
              <p className="text-emerald-100/60 text-sm md:text-lg mb-6 md:mb-8 font-rajdhani tracking-wide">
                Upload once. Share a 24-hour download link.
              </p>
              <p className="text-gray-500 text-xs md:text-sm mb-6 max-w-md leading-relaxed">
                Cloud Drop stores up to {formatBytes(CLOUD_DROP_MAX_BYTES)}. For
                unlimited size, use direct SEND with both browsers online, or
                split large files into 10GB batches.
              </p>

              <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 bg-gray-800/80 hover:bg-gray-700 border border-gray-600 hover:border-emerald-500 text-white py-3 md:py-4 px-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg"
                >
                  <FilePlus className="w-4 h-4 md:w-5 md:h-5 text-emerald-400" />
                  <span className="font-bold tracking-wider text-sm md:text-base">
                    FILES
                  </span>
                </button>

                <button
                  onClick={() => folderInputRef.current?.click()}
                  className="flex-1 bg-gray-800/80 hover:bg-gray-700 border border-gray-600 hover:border-yellow-500 text-white py-3 md:py-4 px-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg"
                >
                  <Folder className="w-4 h-4 md:w-5 md:h-5 text-yellow-400" />
                  <span className="font-bold tracking-wider text-sm md:text-base">
                    FOLDER
                  </span>
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {(status === 'PREPARING' || status === 'UPLOADING') && (
          <motion.div
            key="cloud-uploading"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="w-full max-w-xl space-y-8"
          >
            <div className="text-center">
              <Loader2 className="w-16 h-16 mx-auto text-emerald-400 animate-spin mb-6" />
              <h2 className="text-3xl font-bold mb-2 brand-font text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-cyan-400">
                UPLOADING DROP...
              </h2>
              <p className="text-6xl font-mono font-black text-white drop-shadow-[0_0_20px_rgba(16,185,129,0.5)]">
                {progress.toFixed(1)}
                <span className="text-2xl text-gray-500">%</span>
              </p>
            </div>

            <div className="relative h-6 bg-gray-900/50 rounded-full overflow-hidden border border-gray-700 shadow-inner">
              <motion.div
                className="absolute top-0 left-0 h-full bg-gradient-to-r from-emerald-500 via-cyan-500 to-blue-600"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ type: 'spring', stiffness: 50, damping: 15 }}
              />
            </div>

            <div className="grid grid-cols-2 gap-3 md:gap-4">
              <div className="bg-black/30 backdrop-blur-md p-4 rounded-2xl border border-white/5 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                  Uploaded
                </p>
                <p className="font-mono text-white text-base md:text-lg">
                  {formatBytes(uploadedBytes)}
                </p>
              </div>
              <div className="bg-black/30 backdrop-blur-md p-4 rounded-2xl border border-white/5 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                  Total
                </p>
                <p className="font-mono text-gray-400 text-base md:text-lg">
                  {formatBytes(totalBytes)}
                </p>
              </div>
            </div>

            {currentFile && (
              <p className="text-center text-xs text-gray-500 font-mono truncate px-4">
                {currentFile}
              </p>
            )}
          </motion.div>
        )}

        {status === 'DONE' && shareLink && (
          <motion.div
            key="cloud-done"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`w-full max-w-sm p-6 md:p-8 flex flex-col items-center ${glassPanelClass}`}
          >
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 mb-6 md:mb-8">
              <Check size={14} className="text-emerald-300" />
              <span className="text-xs font-bold text-emerald-300 tracking-[0.2em]">
                DROP READY
              </span>
            </div>

            <button
              className="bg-white p-3 md:p-4 rounded-2xl mb-6 md:mb-8 shadow-[0_0_40px_rgba(16,185,129,0.25)]"
              onClick={copyToClipboard}
            >
              <QRCodeSVG
                value={shareLink}
                size={140}
                className="md:w-[180px] md:h-[180px]"
              />
            </button>

            <button
              onClick={copyToClipboard}
              className="w-full bg-gray-900/60 border border-gray-700 hover:border-emerald-400 rounded-xl p-4 text-left transition-all group"
            >
              <div className="flex items-center gap-3">
                <Copy className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                    Download Link
                  </p>
                  <p className="text-sm text-white font-mono truncate">
                    {shareLink}
                  </p>
                </div>
              </div>
            </button>

            {copied && (
              <p className="text-emerald-300 text-xs font-bold tracking-widest mt-3">
                COPIED
              </p>
            )}

            <div className="w-full bg-gray-800/30 p-4 rounded-xl border border-gray-700/50 flex items-center gap-4 text-left mt-6">
              <div className="w-10 h-10 rounded-lg bg-gray-700/50 flex items-center justify-center flex-shrink-0">
                {manifest?.isFolder ? (
                  <Folder className="text-yellow-400 w-5 h-5" />
                ) : (
                  <FileIcon className="text-blue-400 w-5 h-5" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-white text-sm truncate">
                  {manifest?.rootName}
                </p>
                <p className="text-xs text-gray-400 font-mono mt-0.5">
                  {manifest?.totalFiles} files • {formatBytes(totalBytes)}
                </p>
              </div>
            </div>

            <p className="text-xs text-gray-500 text-center font-mono mt-5">
              Expires {expiryLabel}
            </p>
          </motion.div>
        )}

        {status === 'ERROR' && (
          <motion.div
            key="cloud-error"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="w-full max-w-md bg-red-950/30 border border-red-500/30 rounded-[2rem] p-8 text-center"
          >
            <h2 className="text-2xl font-bold text-red-300 mb-3">
              Upload Failed
            </h2>
            <p className="text-sm text-gray-300 mb-6">{error}</p>
            <button
              onClick={() => setStatus('IDLE')}
              className="px-5 py-3 bg-white text-black rounded-full font-bold tracking-wider hover:bg-red-100 transition-colors"
            >
              TRY AGAIN
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default CloudSenderView;
