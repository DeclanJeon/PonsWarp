import React, { useCallback, useEffect, useRef, useState } from 'react';
import { focusStageHeading } from '../utils/accessibility';
import {
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  Download,
  FileIcon,
  Folder,
  Loader2,
  Lock,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  fetchCloudDownloadUrl,
  getCloudDownloadUrl,
  getCloudShare,
  PublicCloudShareResponse,
} from '../services/cloudShareService';
import { getErrorMessage } from '../utils/errors';
import { classifyCloudShareError } from '../services/cloudShareErrors';
import { formatBytes } from '../utils/fileUtils';
import { formatRemainingTime } from '../utils/transferEstimate';
import { zipSync } from 'fflate';

interface CloudDownloadViewProps {
  shareId: string;
}

type LoadStatus = 'LOADING' | 'READY' | 'ERROR' | 'PASSWORD_REQUIRED';
type DownloadAllStatus = 'IDLE' | 'DOWNLOADING' | 'ERROR';
const DOWNLOAD_SESSION_PREFIX = 'ponswarpCloudDownloadSession:';
// ZIP은 전체를 메모리에 올리므로 대용량 드롭은 파일별 다운로드로 우회한다
const ZIP_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
const INDIVIDUAL_DOWNLOAD_DELAY_MS = 400;

const formatDropWindow = (secondsUntilExpiry: number) => {
  const days = Math.ceil(secondsUntilExpiry / 86400);
  if (days > 1) return `${days}D CLOUD DROP`;
  return '24H CLOUD DROP';
};

const CloudDownloadView: React.FC<CloudDownloadViewProps> = ({ shareId }) => {
  const [status, setStatus] = useState<LoadStatus>('LOADING');
  const [share, setShare] = useState<PublicCloudShareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [storageWarning, setStorageWarning] = useState(false);
  const [password, setPassword] = useState('');
  const [downloadSessionToken, setDownloadSessionToken] = useState<
    string | null
  >(null);
  const tokenRef = useRef<{ shareId: string; token: string | null }>({ shareId, token: null });
  const [downloadAllStatus, setDownloadAllStatus] =
    useState<DownloadAllStatus>('IDLE');
  const [downloadAllError, setDownloadAllError] = useState<string | null>(null);
  const [failedFiles, setFailedFiles] = useState<string[]>([]);
  const [downloadAllBytes, setDownloadAllBytes] = useState(0);
  const [downloadAllFilesDone, setDownloadAllFilesDone] = useState<
    number | null
  >(null);

  const rememberDownloadToken = useCallback((token: string | null) => {
    tokenRef.current = { shareId, token };
    setDownloadSessionToken(token);
    if (!token) return;
    try {
      window.localStorage.setItem(`${DOWNLOAD_SESSION_PREFIX}${shareId}`, token);
    } catch {
      setStorageWarning(true);
    }
  }, [shareId]);

  useEffect(() => {
    let cancelled = false;
    const storageKey = `${DOWNLOAD_SESSION_PREFIX}${shareId}`;

    const loadShare = async () => {
      setStatus('LOADING');
      setError(null);
      setErrorCode(null);
      try {
        let storedToken = tokenRef.current.shareId === shareId ? tokenRef.current.token : null;
        try {
          if (!storedToken) storedToken = window.localStorage.getItem(storageKey);
        } catch {
          setStorageWarning(true);
        }
        const nextShare = await getCloudShare(shareId, {
          downloadSessionToken: storedToken || undefined,
        });
        if (cancelled) return;
        rememberDownloadToken(nextShare.downloadSessionToken || storedToken);
        setShare(nextShare);
        setStatus('READY');
      } catch (loadError) {
        if (cancelled) return;
        const info = classifyCloudShareError(loadError);
        setErrorCode(info.code);
        setError(info.code === 'password' ? null : info.message);
        setStatus(info.code === 'password' ? 'PASSWORD_REQUIRED' : 'ERROR');
      }
    };

    loadShare();
    return () => {
      cancelled = true;
    };
  }, [shareId, refreshVersion, rememberDownloadToken]);

  const expiryLabel = share
    ? new Date(share.expiresAt * 1000).toLocaleString()
    : '';
  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedPassword = password.trim();
    if (!trimmedPassword) return;

    setStatus('LOADING');
    setError(null);
    try {
      const nextShare = await getCloudShare(shareId, {
        password: trimmedPassword,
      });
      rememberDownloadToken(nextShare.downloadSessionToken || null);
      setShare(nextShare);
      setPassword('');
      setStatus('READY');
    } catch (unlockError) {
      const info = classifyCloudShareError(unlockError);
      setErrorCode(info.code);
      setError(info.code === 'password'
        ? 'The password was not accepted. Check it with the sender and try again.'
        : info.message);
      setStatus(info.code === 'password' ? 'PASSWORD_REQUIRED' : 'ERROR');
    }
  };

  const downloadAllIndividually = async () => {
    if (!share) return;
    const token = downloadSessionToken || share.downloadSessionToken;
    setDownloadAllFilesDone(0);
    try {
      for (const [index, file] of share.files.entries()) {
        const anchor = document.createElement('a');
        anchor.href = getCloudDownloadUrl(share.shareId, file.id, token);
        anchor.download = file.name;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setDownloadAllFilesDone(index + 1);
        if (index < share.files.length - 1) {
          await new Promise<void>(resolve =>
            setTimeout(resolve, INDIVIDUAL_DOWNLOAD_DELAY_MS)
          );
        }
      }
      setDownloadAllStatus('IDLE');
    } catch (downloadError) {
      const message = getErrorMessage(downloadError, 'Bulk download failed');
      setDownloadAllError(message);
      setDownloadAllStatus('ERROR');
    } finally {
      setDownloadAllFilesDone(null);
    }
  };

  const downloadAll = async () => {
    if (!share || !share.completed) return;
    if (share.files.length === 0) return;

    setDownloadAllStatus('DOWNLOADING');
    setDownloadAllError(null);
    setFailedFiles([]);
    setDownloadAllBytes(0);

    // Single file: plain anchor download — no fetch, no ZIP, no CORS risk.
    if (share.files.length === 1) {
      const file = share.files[0];
      const anchor = document.createElement('a');
      anchor.href = getCloudDownloadUrl(
        share.shareId,
        file.id,
        downloadSessionToken || share.downloadSessionToken
      );
      anchor.download = file.name;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setDownloadAllStatus('IDLE');
      return;
    }

    if (isLargeDrop) {
      await downloadAllIndividually();
      return;
    }

    try {
      const zipEntries: Record<string, Uint8Array> = {};
      const failures: Array<{ name: string; error: string }> = [];
      const token = downloadSessionToken || share.downloadSessionToken;

      await Promise.allSettled(
        share.files.map(async file => {
          try {
            // Resolve the presigned URL first, then fetch it directly.
            // Following the server's 307 sends Origin:null to R2 → CORS block.
            const url = await fetchCloudDownloadUrl(
              share.shareId,
              file.id,
              token
            );
            const response = await fetch(url);
            if (!response.ok) {
              failures.push({
                name: file.path || file.name,
                error: `HTTP ${response.status}`,
              });
              return;
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            const path = (file.path || file.name).replace(/^\/+/, '');
            zipEntries[path] = bytes;
            setDownloadAllBytes(prev => prev + bytes.length);
          } catch (fileError) {
            failures.push({
              name: file.path || file.name,
              error: getErrorMessage(fileError, 'fetch failed'),
            });
          }
        })
      );

      if (failures.length > 0) {
        setFailedFiles(failures.map(file => file.name));
        setDownloadAllError(
          `${failures.length} file(s) could not be downloaded. No ZIP was saved. Retry or download individual files below.`
        );
        setDownloadAllBytes(0);
        setDownloadAllStatus('ERROR');
        return;
      }

      const zipped = zipSync(zipEntries, { level: 0 });
      const sliced = zipped.slice();
      const blob = new Blob([sliced.buffer], { type: 'application/zip' });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${share.rootName || share.shareId}.zip`;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(objectUrl);
      setDownloadAllStatus('IDLE');
      setDownloadAllBytes(0);
    } catch (downloadError) {
      const message = getErrorMessage(downloadError, 'Bulk download failed');
      setDownloadAllError(message);
      setDownloadAllStatus('ERROR');
    }
  };

  const glassPanelClass =
    'bg-black/40 backdrop-blur-2xl border border-emerald-500/20 rounded-[2rem] shadow-[0_0_40px_rgba(0,0,0,0.3)] overflow-hidden';
  const disableDownloadAll =
    downloadAllStatus === 'DOWNLOADING' || !share?.completed;
  const totalDropBytes = share
    ? share.totalSize || share.files.reduce((sum, file) => sum + file.size, 0)
    : 0;
  const isLargeDrop = totalDropBytes > ZIP_DOWNLOAD_MAX_BYTES;

  return (
    <div className="relative z-10 flex min-h-full w-full flex-col items-center justify-start px-1 py-2 sm:px-3 sm:py-4 md:justify-center md:px-0">
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {status === 'LOADING' ? 'Loading download details.' : status === 'PASSWORD_REQUIRED' ? 'Enter the share password.' : status === 'ERROR' ? 'Download link unavailable. Review recovery options.' : downloadAllStatus === 'DOWNLOADING' ? 'Preparing downloads. Keep this page open.' : 'Download details ready.'}
      </p>
      <AnimatePresence mode="wait">
        {status === 'LOADING' && (
          <motion.div
            key="cloud-loading"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="text-center p-8 bg-emerald-900/20 rounded-3xl border border-emerald-500/30 max-w-lg w-full"
          >
            <Loader2 className="w-16 h-16 text-emerald-400 animate-spin mx-auto mb-6" />
            <h2 className="text-2xl font-bold text-white mb-2">
              Loading Cloud Drop...
            </h2>
            <p className="text-gray-400 font-mono text-xs">{shareId}</p>
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
            <AlertTriangle className="w-12 h-12 text-red-300 mx-auto mb-5" />
            <h2 ref={focusStageHeading} tabIndex={-1} className="text-2xl font-bold text-red-300 mb-3">
              Drop Unavailable
            </h2>
            <p className="text-sm text-gray-300">{error}</p>
            {errorCode === 'not-found' ? (
              <p className="mt-4 text-sm text-gray-300">Ask the sender for a new download link.</p>
            ) : (
              <button type="button" onClick={() => setRefreshVersion(value => value + 1)} className="mt-4 min-h-11 rounded-xl border border-white/20 px-4 py-3 text-white">
                Retry loading
              </button>
            )}
          </motion.div>
        )}

        {status === 'PASSWORD_REQUIRED' && (
          <motion.form
            key="cloud-password"
            onSubmit={submitPassword}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="w-full max-w-md bg-black/40 backdrop-blur-2xl border border-emerald-500/25 rounded-[2rem] p-8"
          >
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-5">
              <Lock className="w-6 h-6 text-emerald-300" />
            </div>
            <h2 ref={focusStageHeading} tabIndex={-1} className="text-2xl font-bold text-white mb-3">
              Password Required
            </h2>
            <p className="text-sm text-gray-400 mb-5">
              Enter the password from the sender to open this Cloud Drop.
            </p>
            <label htmlFor="cloud-password" className="mb-2 block text-sm font-bold text-gray-200">Share password</label>
            <input
              id="cloud-password"
              name="password"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'cloud-password-error' : undefined}
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              className="mb-3 w-full rounded-xl border border-gray-700 bg-gray-950/70 px-4 py-3 text-base text-white outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/40"
              autoComplete="current-password"
            />
            {error && (
              <p id="cloud-password-error" role="alert" className="mb-3 text-sm text-red-300">{error}</p>
            )}
            <button
              type="submit"
              disabled={!password.trim()}
              className="w-full py-3 rounded-xl bg-emerald-500/20 border border-emerald-400/50 text-emerald-100 font-bold tracking-wider disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Unlock download
            </button>
          </motion.form>
        )}

        {status === 'READY' && share && (
          <motion.div
            key="cloud-ready"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`w-full max-w-2xl shrink-0 p-4 sm:p-6 md:p-8 ${glassPanelClass}`}
          >
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6 mb-6">
              <div className="flex items-start gap-4 min-w-0">
                <div className="w-14 h-14 rounded-2xl bg-emerald-900/30 border border-emerald-500/30 flex items-center justify-center flex-shrink-0">
                  <CloudDownload className="w-7 h-7 text-emerald-300" />
                </div>
                <div className="min-w-0">
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 mb-3">
                    <CheckCircle2 size={13} className="text-emerald-300" />
                    <span className="text-[10px] font-bold text-emerald-300 tracking-[0.2em]">
                      {formatDropWindow(share.secondsUntilExpiry)}
                    </span>
                  </div>
                  <h2 ref={focusStageHeading} tabIndex={-1} title={share.rootName} className="text-2xl md:text-4xl font-bold brand-font text-white break-words">
                    {share.rootName}
                  </h2>
                  <p className="text-sm text-gray-400 font-mono mt-2">
                    {share.totalFiles} files • {formatBytes(share.totalSize)}
                  </p>
                </div>
              </div>

              <div className="text-left md:text-right text-xs font-mono text-gray-500">
                <p>Expires {expiryLabel}</p>
                <p>{formatRemainingTime(share.secondsUntilExpiry)}</p>
              </div>
            </div>
            {storageWarning && (
              <p className="mb-4 text-sm text-amber-200">This browser cannot remember access. Downloads still work, but you may need the password again next time.</p>
            )}

            {!share.completed && (
              <div className="bg-yellow-900/30 border border-yellow-500/30 rounded-2xl p-4 text-yellow-100 text-sm mb-5">
                <p>Sender upload is still finishing. Check again when the sender is ready.</p>
                <button type="button" onClick={() => setRefreshVersion(value => value + 1)} className="mt-3 min-h-11 rounded-lg border border-yellow-300/40 px-4 py-2">
                  Refresh status
                </button>
              </div>
            )}

            {downloadAllStatus === 'DOWNLOADING' && (
              <div role="progressbar" aria-label="Preparing downloads" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={isLargeDrop ? Math.round(((downloadAllFilesDone || 0) / share.files.length) * 100) : totalDropBytes > 0 ? Math.min(100, Math.round((downloadAllBytes / totalDropBytes) * 100)) : undefined}
                className="sr-only" />
            )}
            <div className="flex items-center gap-3 mb-4">
              <button
                onClick={downloadAll}
                disabled={disableDownloadAll}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-2 text-sm font-bold text-emerald-200 transition hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download className="w-4 h-4" />
                {downloadAllStatus === 'DOWNLOADING'
                  ? downloadAllFilesDone !== null
                    ? 'Downloading files…'
                    : 'Preparing ZIP…'
                  : downloadAllStatus === 'ERROR' ? 'Retry download all' : 'Download all'}
              </button>
              {downloadAllStatus === 'DOWNLOADING' &&
                downloadAllFilesDone !== null && (
                  <span className="text-xs font-mono text-gray-400">
                    {downloadAllFilesDone}/{share.files.length} files
                  </span>
                )}
              {downloadAllStatus === 'DOWNLOADING' &&
                downloadAllFilesDone === null && (
                  <span className="text-xs font-mono text-gray-400">
                    {formatBytes(downloadAllBytes)} buffered
                  </span>
                )}
              {downloadAllStatus !== 'DOWNLOADING' && isLargeDrop && (
                <span className="text-xs text-gray-500">
                  Large drop — files download individually
                </span>
              )}
            </div>
            {downloadAllStatus === 'ERROR' && (
              <div role="alert" className="mb-4 rounded-xl border border-red-400/30 bg-red-950/30 p-4 text-sm text-red-200">
                <p>{downloadAllError || 'Download failed. Please try again.'}</p>
                {failedFiles.length > 0 && (
                  <ul className="mt-2 max-h-32 list-inside list-disc overflow-y-auto break-words">
                    {failedFiles.map((name, index) => <li key={`${index}:${name}`}>{name}</li>)}
                  </ul>
                )}
              </div>
            )}


            <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
              {share.files.map(file => (
                <div
                  key={file.id}
                  className="flex items-center gap-4 bg-gray-900/50 border border-gray-700/50 rounded-2xl p-4"
                >
                  <div className="w-10 h-10 rounded-xl bg-gray-800/80 flex items-center justify-center flex-shrink-0">
                    {file.path.includes('/') ? (
                      <Folder className="w-5 h-5 text-yellow-400" />
                    ) : (
                      <FileIcon className="w-5 h-5 text-blue-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p title={file.name} className="break-words text-sm font-bold text-white">
                      {file.name}
                    </p>
                    <p title={file.path} className="break-words text-xs text-gray-400 font-mono">
                      {file.path} • {formatBytes(file.size)}
                    </p>
                  </div>
                  {share.completed ? (
                    <a
                      href={getCloudDownloadUrl(share.shareId, file.id, downloadSessionToken || share.downloadSessionToken)}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 transition-colors hover:bg-emerald-500/20"
                      aria-label={`Download ${file.name}`}
                    >
                      <Download className="h-5 w-5" />
                    </a>
                  ) : (
                    <button type="button" disabled aria-label={`Download ${file.name} — waiting for sender`}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-gray-700/50 bg-gray-800/40 text-gray-400">
                      <Download className="h-5 w-5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default CloudDownloadView;
