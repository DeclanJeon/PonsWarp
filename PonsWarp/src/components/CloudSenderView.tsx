import React, { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Check,
  CloudUpload,
  FileIcon,
  FilePlus,
  Folder,
  Infinity,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  abortCloudShareUploads,
  CompletedMultipartUpload,
  CreateCloudShareResponse,
  CloudPlansResponse,
  completeCloudShare,
  createCloudShare,
  getCloudPlans,
  uploadCloudFile,
} from '../services/cloudShareService';
import {
  scanFiles,
  processInputFiles,
  snapshotFileListProgressive,
  ScannedFile,
  FileScanProgress,
} from '../utils/fileScanner';
import { getErrorMessage } from '../utils/errors';
import { createManifestProgressive, formatBytes } from '../utils/fileUtils';
import {
  estimateRemainingSeconds,
  formatRemainingTime,
  getTransferFeedbackLabel,
  TransferSpeedMeter,
} from '../utils/transferEstimate';
import { TransferManifest, AppMode } from '../types/types';
import { formatCloudShareCode } from '../utils/cloudShareCode';
import { useTransferStore } from '../store/transferStore';
import { ShareLinkPanel } from './ui/ShareLinkPanel';
import { focusStageHeading } from '../utils/accessibility';

type CloudUploadStatus =
  | 'IDLE'
  | 'SCANNING'
  | 'PREPARING'
  | 'UPLOADING'
  | 'DONE'
  | 'ERROR'
  | 'LIMIT_EXCEEDED';

type DirectoryInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  webkitdirectory: string;
};

const directoryInputProps: DirectoryInputProps = { webkitdirectory: '' };

const MAX_PARALLEL_UPLOADS = 3;
const GB = 1024 * 1024 * 1024;
const TB = 1024 * GB;

const FALLBACK_CLOUD_PLANS: CloudPlansResponse = {
  directP2p: {
    label: 'Free Direct Send',
    unlimited: true,
    priceKrw: 0,
  },
  free: {
    sku: 'free_cloud_10gb_24h',
    label: 'PonsWarp Free',
    priceKrw: 0,
    maxTotalBytes: 10 * GB,
    maxFileBytes: 10 * GB,
    retentionSeconds: 24 * 60 * 60,
    available: true,
  },
  passes: [
    {
      sku: 'drop_100gb_3d',
      label: '100GB Drop Pass',
      priceKrw: 1900,
      maxTotalBytes: 100 * GB,
      maxFileBytes: 100 * GB,
      retentionSeconds: 3 * 24 * 60 * 60,
      downloadLimit: 10,
      available: false,
    },
    {
      sku: 'drop_500gb_7d',
      label: '500GB Drop Pass',
      priceKrw: 4900,
      maxTotalBytes: 500 * GB,
      maxFileBytes: 500 * GB,
      retentionSeconds: 7 * 24 * 60 * 60,
      downloadLimit: 20,
      available: false,
    },
    {
      sku: 'drop_1tb_7d',
      label: '1TB Drop Pass',
      priceKrw: 9900,
      maxTotalBytes: TB,
      maxFileBytes: TB,
      retentionSeconds: 7 * 24 * 60 * 60,
      downloadLimit: 30,
      available: false,
    },
  ],
  pro: {
    sku: 'pro_monthly_krw_9900',
    label: 'PonsWarp Pro',
    priceKrw: 9900,
    maxTotalBytes: TB,
    maxFileBytes: TB,
    retentionSeconds: 7 * 24 * 60 * 60,
    downloadLimit: 30,
    available: false,
    monthlyQuotaBytes: 2 * TB,
    concurrentStorageBytes: TB,
  },
  checkoutEnabled: false,
  paymentProviders: [],
};

const formatRetention = (seconds: number) => {
  const days = Math.round(seconds / 86400);
  if (days >= 1) return `${days} days`;
  const hours = Math.round(seconds / 3600);
  return `${hours} hours`;
};

const CloudSenderView: React.FC = () => {
  useEffect(() => {
    useTransferStore.setState({ mode: AppMode.CLOUD_SENDER });
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatusState] = useState<CloudUploadStatus>('IDLE');
  const setStatus = (next: CloudUploadStatus) => {
    setStatusState(next);
    useTransferStore.setState({
      status: next as any,
      mode: AppMode.CLOUD_SENDER,
    });
  };
  const [scanProgress, setScanProgress] = useState<FileScanProgress | null>(
    null
  );
  const [manifest, setManifest] = useState<TransferManifest | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [fileProgress, setFileProgress] = useState<Record<string, number>>({});
  const [cloudPlans, setCloudPlans] =
    useState<CloudPlansResponse>(FALLBACK_CLOUD_PLANS);
  const uploadSpeedMeterRef = useRef(new TransferSpeedMeter());
  const [uploadSpeed, setUploadSpeed] = useState(0);

  const uploadedBytes = useMemo(
    () =>
      Object.values(fileProgress).reduce((total, value) => total + value, 0),
    [fileProgress]
  );
  const totalBytes = manifest?.totalSize || 0;
  const progress =
    totalBytes > 0 ? Math.min(100, (uploadedBytes / totalBytes) * 100) : 0;
  const estimatedUploadSecondsRemaining = estimateRemainingSeconds(
    uploadedBytes,
    totalBytes,
    uploadSpeed
  );
  const uploadFeedbackLabel = getTransferFeedbackLabel(
    uploadedBytes,
    totalBytes,
    uploadSpeed
  );
  const freePlan = cloudPlans.free;


  useEffect(() => {
    if (status !== 'UPLOADING') return;
    const speed = uploadSpeedMeterRef.current.update(uploadedBytes, Date.now());
    setUploadSpeed(speed);
  }, [status, uploadedBytes]);

  useEffect(() => {
    let cancelled = false;

    getCloudPlans()
      .then(nextPlans => {
        if (!cancelled) {
          setCloudPlans(nextPlans);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCloudPlans(FALLBACK_CLOUD_PLANS);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleScanProgress = (progress: FileScanProgress) => {
    setScanProgress(prev => {
      if (
        prev &&
        progress.phase === 'listing' &&
        progress.scannedFiles - (prev.scannedFiles || 0) < 64 &&
        progress.totalHint === prev.totalHint
      ) {
        return prev;
      }
      return progress;
    });
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Progressive snapshot first: input.value = '' clears the live FileList.
    const live = e.target.files;
    const totalHint = live?.length ?? 0;
    if (!live || totalHint === 0) {
      e.target.value = '';
      return;
    }
    setScanProgress({
      scannedFiles: 0,
      totalHint,
      phase: 'listing',
    });
    setStatus('SCANNING');
    try {
      const fileList = await snapshotFileListProgressive(live, {
        onProgress: progress => {
          setScanProgress(prev => ({
            scannedFiles: prev?.scannedFiles ?? 0,
            totalHint: progress.totalHint ?? totalHint,
            phase: 'listing',
          }));
        },
      });
      e.target.value = '';
      if (fileList.length === 0) {
        setScanProgress(null);
        setStatus('IDLE');
        return;
      }
      const scanned = await processInputFiles(fileList, {
        onProgress: handleScanProgress,
      });
      await processScannedFiles(scanned);
    } catch (error) {
      e.target.value = '';
      if ((error as DOMException)?.name === 'AbortError') return;
      setScanProgress(null);
      setStatus('ERROR');
      setError(getErrorMessage(error, 'Failed to load selected files'));
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setScanProgress({ scannedFiles: 0, phase: 'listing' });
    setStatus('SCANNING');
    try {
      if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        const scanned = await scanFiles(e.dataTransfer.items, {
          onProgress: handleScanProgress,
        });
        await processScannedFiles(scanned);
        return;
      }
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const dropped = await snapshotFileListProgressive(
          e.dataTransfer.files,
          {
            onProgress: handleScanProgress,
          }
        );
        const scanned = await processInputFiles(dropped, {
          onProgress: handleScanProgress,
        });
        await processScannedFiles(scanned);
        return;
      }
      setScanProgress(null);
      setStatus('IDLE');
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') return;
      setScanProgress(null);
      setStatus('ERROR');
      setError(getErrorMessage(error, 'Failed to load dropped files'));
    }
  };

  const processScannedFiles = async (scannedFiles: ScannedFile[]) => {
    if (scannedFiles.length === 0) {
      setScanProgress(null);
      setError('No transferable files found (empty or filtered selection).');
      setStatus('ERROR');
      return;
    }
    setScanProgress({
      scannedFiles: scannedFiles.length,
      phase: 'done',
    });

    const { manifest: nextManifest } =
      await createManifestProgressive(scannedFiles);
    const oversizedFile = scannedFiles.find(
      item => item.file.size > freePlan.maxFileBytes
    );

    if (nextManifest.totalSize > freePlan.maxTotalBytes) {
      setManifest(nextManifest);
      setShareLink(null);
      setShareCode(null);
      setExpiresAt(null);
      setFileProgress({});
      uploadSpeedMeterRef.current.reset(0);
      setUploadSpeed(0);
      setCurrentFile(null);
      setError(
        `This Cloud Drop is ${formatBytes(nextManifest.totalSize)}, which is over the ${formatBytes(freePlan.maxTotalBytes)} link-sending limit. Direct SEND remains unlimited when both browsers stay online.`
      );
      setStatus('LIMIT_EXCEEDED');
      return;
    }

    if (oversizedFile) {
      setManifest(nextManifest);
      setShareLink(null);
      setShareCode(null);
      setExpiresAt(null);
      setFileProgress({});
      uploadSpeedMeterRef.current.reset(0);
      setUploadSpeed(0);
      setCurrentFile(null);
      setError(
        `${oversizedFile.path} is larger than the per-file link-sending limit of ${formatBytes(freePlan.maxFileBytes)}. Direct SEND remains unlimited when both browsers stay online.`
      );
      setStatus('LIMIT_EXCEEDED');
      return;
    }

    setManifest(nextManifest);
    setShareLink(null);
    setShareCode(null);
    setExpiresAt(null);
    setError(null);
    setFileProgress({});
    uploadSpeedMeterRef.current.reset(0);
    setUploadSpeed(0);
    setStatus('PREPARING');
    let createdShare: CreateCloudShareResponse | null = null;

    try {
      const created = await createCloudShare(
        nextManifest.rootName,
        scannedFiles
      );
      createdShare = created;
      const uploadedIds: string[] = [];
      const multipartUploads: CompletedMultipartUpload[] = [];
      let nextIndex = 0;

      setStatus('UPLOADING');
      uploadSpeedMeterRef.current.reset(0, Date.now());

      const uploadWorker = async () => {
        while (nextIndex < created.files.length) {
          const index = nextIndex;
          nextIndex += 1;

          const target = created.files[index];
          const source = scannedFiles[index];
          if (!target || !source) continue;

          setCurrentFile(target.path);
          const multipartUpload = await uploadCloudFile(
            target,
            source.file,
            progressEvent => {
              setFileProgress(prev => ({
                ...prev,
                [target.id]: progressEvent.loaded,
              }));
            }
          );
          if (multipartUpload) {
            multipartUploads.push(multipartUpload);
          }
          uploadedIds.push(target.id);
        }
      };

      const workerCount = Math.min(MAX_PARALLEL_UPLOADS, created.files.length);
      await Promise.all(Array.from({ length: workerCount }, uploadWorker));

      const completed = await completeCloudShare(
        created.shareId,
        uploadedIds,
        multipartUploads
      );
      setCurrentFile(null);
      setExpiresAt(completed.expiresAt);
      setShareCode(created.shareId);
      setShareLink(`${window.location.origin}${created.shareUrl}`);
      setStatus('DONE');
    } catch (uploadError) {
      if (createdShare) {
        const multipartUploadsToAbort = createdShare.files
          .filter(target => target.multipart)
          .map(target => ({
            fileId: target.id,
            uploadId: target.multipart!.uploadId,
          }));
        abortCloudShareUploads(
          createdShare.shareId,
          multipartUploadsToAbort
        ).catch(error => {
          console.warn('Failed to abort incomplete Cloud Drop upload', error);
        });
      }
      setStatus('ERROR');
      setError(getErrorMessage(uploadError, 'Cloud upload failed'));
    } finally {
      uploadSpeedMeterRef.current.reset(0);
    }
  };


  const expiryLabel = expiresAt
    ? new Date(expiresAt * 1000).toLocaleString()
    : '24 hours after upload';

  const glassPanelClass =
    'bg-black/40 backdrop-blur-2xl border border-emerald-500/20 rounded-[2rem] shadow-[0_0_40px_rgba(0,0,0,0.3)] overflow-hidden';

  return (
    <div className="relative z-10 flex min-h-full w-full flex-col items-center justify-start px-1 py-2 sm:px-3 sm:py-4 md:justify-center md:px-0">
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
              className="flex flex-col items-center justify-center rounded-[1.8rem] border-2 border-dashed border-emerald-500/30 px-4 py-6 text-center transition-all hover:border-emerald-400/60 hover:bg-emerald-500/5 sm:px-6 sm:py-8 md:px-10 md:py-10"
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
                {...directoryInputProps}
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
              <p className="text-gray-500 text-xs md:text-sm mb-4 max-w-md leading-relaxed">
                Free Cloud Drop stores up to{' '}
                {formatBytes(freePlan.maxTotalBytes)} for{' '}
                {formatRetention(freePlan.retentionSeconds)} without sign-in.
                Direct SEND stays unlimited when both browsers are online.
              </p>
              <div className="mb-6 flex flex-wrap items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em]">
                <span className="rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3 py-1 text-emerald-200">
                  No sign-in required
                </span>
                <span className="rounded-full border border-cyan-400/25 bg-cyan-500/10 px-3 py-1 text-cyan-100">
                  10GB per link
                </span>
              </div>

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

        {status === 'SCANNING' && (
          <motion.div
            key="cloud-scanning"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="w-full max-w-md p-8 flex flex-col items-center text-center bg-black/40 backdrop-blur-2xl border border-emerald-500/20 rounded-[2rem]"
          >
            <Loader2 className="w-12 h-12 text-emerald-400 animate-spin mb-5" />
            <h2 className="text-2xl font-bold brand-font text-white mb-2">
              LOADING FILES
            </h2>
            <p className="text-emerald-100/70 font-mono text-sm mb-4">
              Preparing Cloud Drop list
            </p>
            <p className="text-4xl font-mono font-black text-emerald-300">
              {scanProgress?.scannedFiles ?? 0}
              {typeof scanProgress?.totalHint === 'number' &&
              scanProgress.totalHint > 0 ? (
                <span className="text-lg text-gray-500">
                  {' '}
                  / {scanProgress.totalHint}
                </span>
              ) : null}
            </p>
          </motion.div>
        )}

        {(status === 'PREPARING' || status === 'UPLOADING') && (
          <motion.div
            key="cloud-uploading"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="w-full max-w-xl space-y-5 sm:space-y-8"
          >
            <div className="text-center">
              <Loader2 className="mx-auto mb-4 h-12 w-12 animate-spin text-emerald-400 sm:mb-6 sm:h-16 sm:w-16" />
              <h2 className="mb-2 brand-font text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-cyan-400 sm:text-3xl">
                Uploading files…
              </h2>
              <p className="font-mono text-5xl font-black text-white drop-shadow-[0_0_20px_rgba(16,185,129,0.5)] sm:text-6xl">
                {progress.toFixed(1)}
                <span className="text-2xl text-gray-500">%</span>
              </p>
              <p className="mt-3 break-words font-mono text-xs text-emerald-100/70 sm:text-sm">
                {uploadFeedbackLabel}
              </p>
            </div>

            <div role="progressbar" aria-label="Uploading files" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="relative h-6 bg-gray-900/50 rounded-full overflow-hidden border border-gray-700 shadow-inner">
              <motion.div
                className="absolute top-0 left-0 h-full bg-gradient-to-r from-emerald-500 via-cyan-500 to-blue-600"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ type: 'spring', stiffness: 50, damping: 15 }}
              />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
              <div className="bg-black/30 backdrop-blur-md p-4 rounded-2xl border border-white/5 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                  Speed
                </p>
                <p className="font-mono text-emerald-300 text-base md:text-lg">
                  {formatBytes(uploadSpeed)}/s
                </p>
              </div>
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
                  Time Left
                </p>
                <p className="font-mono text-white text-base md:text-lg">
                  {formatRemainingTime(estimatedUploadSecondsRemaining)}
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
              <p title={currentFile} className="break-words px-4 text-center text-xs text-gray-400 font-mono">
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
            className={`w-full max-w-2xl p-4 sm:p-6 md:p-8 ${glassPanelClass}`}
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5">
                <Check size={14} className="text-emerald-300" />
                <span className="text-xs font-bold tracking-[0.2em] text-emerald-300">
                  DROP READY
                </span>
              </div>
              <p className="text-xs text-gray-400">Ready to share</p>
            </div>

            <h2 ref={focusStageHeading} tabIndex={-1} className="brand-font text-xl font-bold text-white sm:text-2xl">
              Share your download link
            </h2>
            <p className="mt-2 text-sm leading-6 text-gray-400">
              Copy the link or let the receiver scan the QR code.
              You can close this page after sharing.
            </p>

            <div className="mt-5 grid min-w-0 gap-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
              <ShareLinkPanel
                link={shareLink}
                code={shareCode || ''}
                displayCode={shareCode ? formatCloudShareCode(shareCode) : ''}
                codeLabel="Drop code"
              />

              <div className="flex flex-col items-center gap-3">
                <div className="rounded-2xl bg-white p-3 shadow-[0_0_40px_rgba(16,185,129,0.15)]">
                  <QRCodeSVG
                    value={shareLink}
                    size={160}
                    title="Scan to open the download link"
                    className="h-36 w-36 sm:h-40 sm:w-40"
                  />
                </div>
                <p className="text-xs text-gray-400">Scan to download</p>
              </div>
            </div>

            <div className="mt-4 flex w-full items-center gap-3 rounded-xl border border-gray-700/50 bg-gray-800/30 p-3 text-left sm:p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-700/50">
                {manifest?.isFolder ? (
                  <Folder className="h-5 w-5 text-yellow-400" />
                ) : (
                  <FileIcon className="h-5 w-5 text-blue-400" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p title={manifest?.rootName} className="break-words text-sm font-bold text-white">
                  {manifest?.rootName}
                </p>
                <p className="mt-0.5 font-mono text-xs text-gray-400">
                  {manifest?.totalFiles} files • {formatBytes(totalBytes)}
                </p>
              </div>
            </div>
            <p className="mt-4 break-words text-center font-mono text-xs leading-5 text-gray-400">
              Expires {expiryLabel}
            </p>
          </motion.div>
        )}

        {status === 'LIMIT_EXCEEDED' && (
          <motion.div
            key="cloud-limit"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className={`w-full max-w-xl p-5 md:p-7 ${glassPanelClass}`}
          >
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30">
                <Infinity className="w-4 h-4 text-cyan-300" />
                <span className="text-[10px] font-bold text-cyan-300 tracking-[0.2em]">
                  DIRECT P2P
                </span>
              </div>
              <div>
                <h2 ref={focusStageHeading} tabIndex={-1} className="text-2xl md:text-3xl font-bold brand-font text-white mb-3">
                  FREE LIMIT REACHED
                </h2>
                <p className="text-sm text-gray-300 leading-relaxed">{error}</p>
              </div>
              <div className="bg-cyan-500/10 border border-cyan-500/25 rounded-2xl p-4">
                <div className="flex items-center gap-3 mb-2">
                  <ShieldCheck className="w-5 h-5 text-cyan-300" />
                  <p className="font-bold text-white text-sm">
                    Unlimited transfer is still free
                  </p>
                </div>
                <p className="text-xs text-gray-400 leading-relaxed">
                  SEND remains the free path for very large files when both
                  browsers are online. Cloud Drop covers offline pickup.
                </p>
              </div>
              <div className="bg-black/30 border border-white/10 rounded-2xl p-4">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                  Selected
                </p>
                <p title={manifest?.rootName} className="break-words text-sm text-white font-bold">
                  {manifest?.rootName}
                </p>
                <p className="text-xs text-gray-400 font-mono mt-1">
                  {manifest?.totalFiles} files • {formatBytes(totalBytes)}
                </p>
              </div>
              <button
                onClick={() => setStatus('IDLE')}
                className="w-full px-5 py-3 bg-white text-black rounded-full font-bold tracking-wider hover:bg-cyan-100 transition-colors"
              >
                CHOOSE ANOTHER FILE
              </button>
            </div>
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
            <h2 ref={focusStageHeading} tabIndex={-1} className="text-2xl font-bold text-red-300 mb-3">
              Upload Failed
            </h2>
            <p className="text-sm text-gray-300 mb-6">{error}</p>
            <button
              onClick={() => setStatus('IDLE')}
              className="px-5 py-3 bg-white text-black rounded-full font-bold tracking-wider hover:bg-red-100 transition-colors"
            >
              Choose files to retry
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default CloudSenderView;
