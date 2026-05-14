import React, { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Check,
  CloudUpload,
  Copy,
  CreditCard,
  FileIcon,
  FilePlus,
  Folder,
  Infinity,
  Loader2,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CloudPlanLimit,
  CloudPlansResponse,
  PaymentProvider,
  captureBillingCheckout,
  completeCloudShare,
  createBillingCheckout,
  createCloudShare,
  getCloudPlans,
  uploadCloudFile,
} from '../services/cloudShareService';
import { AuthState } from '../services/authService';
import {
  scanFiles,
  processInputFiles,
  ScannedFile,
} from '../utils/fileScanner';
import { getErrorMessage } from '../utils/errors';
import { createManifest, formatBytes } from '../utils/fileUtils';
import {
  estimateRemainingSeconds,
  formatDuration,
} from '../utils/transferEstimate';
import { TransferManifest } from '../types/types';

type CloudUploadStatus =
  | 'IDLE'
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
const ENTITLEMENT_STORAGE_KEY = 'ponswarpCloudEntitlementToken';

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

interface CloudSenderViewProps {
  authState: AuthState;
  authLoading: boolean;
  onLogin: () => void;
}

const formatKrw = (value: number) =>
  `${new Intl.NumberFormat('ko-KR').format(value)}원`;

const formatRetention = (seconds: number) => {
  const days = Math.round(seconds / 86400);
  if (days >= 1) return `${days} days`;
  const hours = Math.round(seconds / 3600);
  return `${hours} hours`;
};

const CloudSenderView: React.FC<CloudSenderViewProps> = ({
  authState,
  authLoading,
  onLogin,
}) => {
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
  const [entitlementToken, setEntitlementToken] = useState<string | null>(null);
  const [checkoutSku, setCheckoutSku] = useState<string | null>(null);
  const [paymentProvider, setPaymentProvider] =
    useState<PaymentProvider>('lemonSqueezy');
  const [cloudPlans, setCloudPlans] =
    useState<CloudPlansResponse>(FALLBACK_CLOUD_PLANS);
  const [dropPassword, setDropPassword] = useState('');
  const [downloadLimit, setDownloadLimit] = useState('');
  const uploadStartedAtRef = useRef<number | null>(null);

  const uploadedBytes = useMemo(
    () =>
      Object.values(fileProgress).reduce((total, value) => total + value, 0),
    [fileProgress]
  );
  const totalBytes = manifest?.totalSize || 0;
  const progress =
    totalBytes > 0 ? Math.min(100, (uploadedBytes / totalBytes) * 100) : 0;
  const uploadElapsedSeconds =
    uploadStartedAtRef.current && uploadedBytes > 0
      ? (Date.now() - uploadStartedAtRef.current) / 1000
      : 0;
  const uploadSpeed =
    uploadElapsedSeconds > 0 ? uploadedBytes / uploadElapsedSeconds : 0;
  const estimatedUploadSecondsRemaining = estimateRemainingSeconds(
    uploadedBytes,
    totalBytes,
    uploadSpeed
  );
  const freePlan = cloudPlans.free;

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const checkoutStatus = params.get('checkout');
    const nextEntitlement = params.get('cloudEntitlement');
    const storedEntitlement = window.sessionStorage.getItem(
      ENTITLEMENT_STORAGE_KEY
    );
    if (nextEntitlement) {
      setEntitlementToken(nextEntitlement);
      window.sessionStorage.removeItem(ENTITLEMENT_STORAGE_KEY);
      window.history.replaceState({}, '', window.location.pathname);
    } else if (storedEntitlement) {
      setEntitlementToken(storedEntitlement);
      window.sessionStorage.removeItem(ENTITLEMENT_STORAGE_KEY);
      window.history.replaceState({}, '', window.location.pathname);
    } else if (checkoutStatus === 'success') {
      const checkoutProvider = params.get('provider');
      const lemonCheckoutId = params.get('checkout_id');
      const paypalOrderId = params.get('token');
      const paypalSubscriptionId = params.get('subscription_id');
      if (
        (checkoutProvider === 'lemonsqueezy' ||
          checkoutProvider === 'lemonSqueezy') &&
        lemonCheckoutId
      ) {
        setEntitlementToken(lemonCheckoutId);
        setError(null);
        window.history.replaceState({}, '', window.location.pathname);
      } else if (paypalSubscriptionId) {
        setEntitlementToken(paypalSubscriptionId);
        window.history.replaceState({}, '', window.location.pathname);
      } else if (paypalOrderId) {
        captureBillingCheckout(paypalOrderId)
          .then(response => {
            if (cancelled) return;
            setEntitlementToken(response.entitlementToken);
            setError(null);
            window.history.replaceState({}, '', window.location.pathname);
          })
          .catch(captureError => {
            if (cancelled) return;
            setStatus('ERROR');
            setError(captureError?.message || 'PayPal payment capture failed');
          });
      } else {
        setError(
          'Checkout returned without a usable entitlement token. Please wait a moment and retry.'
        );
      }
    } else if (checkoutStatus === 'cancelled') {
      setError('Checkout was cancelled.');
      window.history.replaceState({}, '', window.location.pathname);
    }

    getCloudPlans()
      .then(nextPlans => {
        if (!cancelled) {
          setCloudPlans(nextPlans);
          const defaultProvider = nextPlans.paymentProviders.find(
            provider => provider.default && provider.available
          );
          const firstAvailable = nextPlans.paymentProviders.find(
            provider => provider.available
          );
          setPaymentProvider(
            defaultProvider?.provider ||
              firstAvailable?.provider ||
              'lemonSqueezy'
          );
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
    const oversizedFile = scannedFiles.find(
      item => item.file.size > freePlan.maxFileBytes
    );
    const shouldUseEntitlement = Boolean(entitlementToken);

    if (!entitlementToken && nextManifest.totalSize > freePlan.maxTotalBytes) {
      setManifest(nextManifest);
      setShareLink(null);
      setExpiresAt(null);
      setCopied(false);
      setFileProgress({});
      setCurrentFile(null);
      setError(
        `This Cloud Drop is ${formatBytes(nextManifest.totalSize)}, which is over the free ${formatBytes(freePlan.maxTotalBytes)} limit. Direct P2P remains unlimited, or use a paid Drop Pass when checkout is enabled.`
      );
      setStatus('LIMIT_EXCEEDED');
      return;
    }

    if (!entitlementToken && oversizedFile) {
      setManifest(nextManifest);
      setShareLink(null);
      setExpiresAt(null);
      setCopied(false);
      setFileProgress({});
      setCurrentFile(null);
      setError(
        `${oversizedFile.path} is larger than the free per-file Cloud Drop limit of ${formatBytes(freePlan.maxFileBytes)}. Direct P2P remains unlimited, or use a paid Drop Pass when checkout is enabled.`
      );
      setStatus('LIMIT_EXCEEDED');
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
      const requestedDownloadLimit = Number.parseInt(downloadLimit, 10);
      const created = await createCloudShare(
        nextManifest.rootName,
        scannedFiles,
        shouldUseEntitlement && entitlementToken
          ? {
              entitlementToken,
              password: dropPassword.trim() || undefined,
              downloadLimit:
                Number.isFinite(requestedDownloadLimit) &&
                requestedDownloadLimit > 0
                  ? requestedDownloadLimit
                  : undefined,
            }
          : {}
      );
      const uploadedIds: string[] = [];
      let nextIndex = 0;

      setStatus('UPLOADING');
      uploadStartedAtRef.current = Date.now();

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
      if (shouldUseEntitlement) {
        setEntitlementToken(null);
        setDropPassword('');
        setDownloadLimit('');
      }
      setStatus('DONE');
    } catch (uploadError) {
      setStatus('ERROR');
      setError(getErrorMessage(uploadError, 'Cloud upload failed'));
    } finally {
      uploadStartedAtRef.current = null;
    }
  };

  const copyToClipboard = async () => {
    if (!shareLink) return;
    await navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const startCheckout = async (plan: CloudPlanLimit) => {
    if (!cloudPlans.checkoutEnabled || !plan.available) return;
    if (!authState.authenticated) {
      onLogin();
      return;
    }
    setCheckoutSku(plan.sku);
    setError(null);
    try {
      const response = await createBillingCheckout(
        plan.sku === cloudPlans.pro.sku ? 'subscription' : 'payment',
        plan.sku,
        `${window.location.origin}${window.location.pathname}`,
        paymentProvider
      );
      window.location.href = response.checkoutUrl;
    } catch (checkoutError) {
      setCheckoutSku(null);
      setError(getErrorMessage(checkoutError, 'Checkout failed'));
    }
  };

  const expiryLabel = expiresAt
    ? new Date(expiresAt * 1000).toLocaleString()
    : '24 hours after upload';

  const glassPanelClass =
    'bg-black/40 backdrop-blur-2xl border border-emerald-500/20 rounded-[2rem] shadow-[0_0_40px_rgba(0,0,0,0.3)] overflow-hidden';
  const paidPlans: CloudPlanLimit[] = [...cloudPlans.passes, cloudPlans.pro];

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
              <p className="text-gray-500 text-xs md:text-sm mb-6 max-w-md leading-relaxed">
                Free Cloud Drop stores up to{' '}
                {formatBytes(freePlan.maxTotalBytes)} for{' '}
                {formatRetention(freePlan.retentionSeconds)}. Direct SEND stays
                unlimited when both browsers are online.
              </p>
              {entitlementToken && (
                <div className="w-full max-w-md mb-5 rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-4 text-left">
                  <div className="flex items-center gap-2 mb-3">
                    <ShieldCheck className="w-4 h-4 text-emerald-300" />
                    <p className="text-emerald-200 text-xs md:text-sm font-bold">
                      Paid Cloud Drop is active for the next upload.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block">
                      <span className="flex items-center gap-1.5 text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">
                        <Lock className="w-3 h-3" />
                        Password
                      </span>
                      <input
                        type="password"
                        value={dropPassword}
                        onChange={event => setDropPassword(event.target.value)}
                        placeholder="optional"
                        className="w-full bg-black/40 border border-gray-700 focus:border-emerald-400 outline-none rounded-xl px-3 py-2.5 text-sm text-white"
                        autoComplete="new-password"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5 block">
                        Download cap
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={downloadLimit}
                        onChange={event => setDownloadLimit(event.target.value)}
                        placeholder="plan max"
                        className="w-full bg-black/40 border border-gray-700 focus:border-emerald-400 outline-none rounded-xl px-3 py-2.5 text-sm text-white"
                      />
                    </label>
                  </div>
                </div>
              )}

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
                  {formatDuration(estimatedUploadSecondsRemaining)}
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

        {status === 'LIMIT_EXCEEDED' && (
          <motion.div
            key="cloud-limit"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className={`w-full max-w-5xl p-5 md:p-7 ${glassPanelClass}`}
          >
            <div className="flex flex-col lg:flex-row gap-6">
              <div className="lg:w-[32%] space-y-4">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30">
                  <Infinity className="w-4 h-4 text-cyan-300" />
                  <span className="text-[10px] font-bold text-cyan-300 tracking-[0.2em]">
                    DIRECT P2P
                  </span>
                </div>
                <div>
                  <h2 className="text-2xl md:text-3xl font-bold brand-font text-white mb-3">
                    FREE LIMIT REACHED
                  </h2>
                  <p className="text-sm text-gray-300 leading-relaxed">
                    {error}
                  </p>
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
                  <p className="text-sm text-white font-bold truncate">
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

              <div className="flex-1">
                <div className="flex items-center gap-2 mb-4">
                  <CreditCard className="w-5 h-5 text-emerald-300" />
                  <h3 className="text-lg font-bold text-white brand-font">
                    CLOUD DROP OPTIONS
                  </h3>
                </div>
                <div className="mb-4 flex flex-wrap gap-2">
                  {(cloudPlans.paymentProviders.length
                    ? cloudPlans.paymentProviders
                    : [
                        {
                          provider: 'lemonSqueezy' as PaymentProvider,
                          label: 'Lemon Squeezy',
                          available: false,
                          default: true,
                        },
                      ]
                  ).map(provider => (
                    <button
                      key={provider.provider}
                      type="button"
                      disabled={!provider.available}
                      onClick={() => setPaymentProvider(provider.provider)}
                      className={`px-3 py-2 rounded-full border text-xs font-bold tracking-wider transition-colors ${
                        paymentProvider === provider.provider
                          ? 'border-emerald-400 bg-emerald-500/20 text-emerald-100'
                          : provider.available
                            ? 'border-white/15 bg-white/5 text-gray-300 hover:bg-white/10'
                            : 'border-gray-700 bg-gray-900/60 text-gray-600 cursor-not-allowed'
                      }`}
                    >
                      {provider.label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {paidPlans.map(plan => (
                    <div
                      key={plan.sku}
                      className="bg-gray-900/50 border border-gray-700/60 rounded-2xl p-4 flex flex-col gap-4"
                    >
                      <div>
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div>
                            <p className="text-white font-bold text-base">
                              {plan.label}
                            </p>
                            <p className="text-xs text-gray-500 font-mono">
                              up to {formatBytes(plan.maxTotalBytes)}
                            </p>
                          </div>
                          <p className="text-emerald-300 font-black text-lg whitespace-nowrap">
                            {formatKrw(plan.priceKrw)}
                          </p>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="bg-black/30 rounded-xl p-3 border border-white/5">
                            <p className="text-gray-500 uppercase tracking-widest text-[9px] mb-1">
                              Retention
                            </p>
                            <p className="text-gray-200">
                              {formatRetention(plan.retentionSeconds)}
                            </p>
                          </div>
                          <div className="bg-black/30 rounded-xl p-3 border border-white/5">
                            <p className="text-gray-500 uppercase tracking-widest text-[9px] mb-1">
                              Downloads
                            </p>
                            <p className="text-gray-200">
                              {plan.downloadLimit
                                ? `${plan.downloadLimit} max`
                                : 'basic'}
                            </p>
                          </div>
                        </div>
                      </div>
                      <button
                        disabled={
                          !cloudPlans.checkoutEnabled ||
                          !plan.available ||
                          authLoading ||
                          checkoutSku === plan.sku
                        }
                        onClick={() => startCheckout(plan)}
                        className={`mt-auto w-full py-3 rounded-xl border font-bold tracking-wider transition-colors ${
                          cloudPlans.checkoutEnabled && plan.available
                            ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                            : 'border-gray-700 bg-gray-800/60 text-gray-500 cursor-not-allowed'
                        }`}
                      >
                        {checkoutSku === plan.sku
                          ? 'OPENING CHECKOUT'
                          : cloudPlans.checkoutEnabled && plan.available
                            ? authState.authenticated
                              ? 'CHECKOUT'
                              : 'SIGN IN'
                            : 'CHECKOUT SOON'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
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
