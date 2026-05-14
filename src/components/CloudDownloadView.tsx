import React, { useEffect, useState } from 'react';
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
  getCloudDownloadUrl,
  getCloudShare,
  PublicCloudShareResponse,
} from '../services/cloudShareService';
import { getErrorMessage } from '../utils/errors';
import { formatBytes } from '../utils/fileUtils';

interface CloudDownloadViewProps {
  shareId: string;
}

type LoadStatus = 'LOADING' | 'READY' | 'ERROR' | 'PASSWORD_REQUIRED';
const DOWNLOAD_SESSION_PREFIX = 'ponswarpCloudDownloadSession:';

const formatDropWindow = (secondsUntilExpiry: number) => {
  const days = Math.ceil(secondsUntilExpiry / 86400);
  if (days > 1) return `${days}D CLOUD DROP`;
  return '24H CLOUD DROP';
};

const CloudDownloadView: React.FC<CloudDownloadViewProps> = ({ shareId }) => {
  const [status, setStatus] = useState<LoadStatus>('LOADING');
  const [share, setShare] = useState<PublicCloudShareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [downloadSessionToken, setDownloadSessionToken] = useState<
    string | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    const storageKey = `${DOWNLOAD_SESSION_PREFIX}${shareId}`;

    const loadShare = async () => {
      setStatus('LOADING');
      setError(null);
      try {
        const storedToken = window.localStorage.getItem(storageKey);
        const nextShare = await getCloudShare(shareId, {
          downloadSessionToken: storedToken || undefined,
        });
        if (cancelled) return;
        const nextToken = nextShare.downloadSessionToken || storedToken;
        if (nextToken) {
          setDownloadSessionToken(nextToken);
          window.localStorage.setItem(storageKey, nextToken);
        }
        setShare(nextShare);
        setStatus('READY');
      } catch (loadError) {
        if (cancelled) return;
        const message = getErrorMessage(loadError, 'Cloud share not found');
        setError(message);
        setStatus(
          message === 'Password required' ? 'PASSWORD_REQUIRED' : 'ERROR'
        );
      }
    };

    loadShare();
    return () => {
      cancelled = true;
    };
  }, [shareId]);

  const expiryLabel = share
    ? new Date(share.expiresAt * 1000).toLocaleString()
    : '';
  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedPassword = password.trim();
    if (!trimmedPassword) return;

    const storageKey = `${DOWNLOAD_SESSION_PREFIX}${shareId}`;
    setStatus('LOADING');
    setError(null);
    try {
      const nextShare = await getCloudShare(shareId, {
        password: trimmedPassword,
      });
      const nextToken = nextShare.downloadSessionToken;
      if (nextToken) {
        setDownloadSessionToken(nextToken);
        window.localStorage.setItem(storageKey, nextToken);
      }
      setShare(nextShare);
      setPassword('');
      setStatus('READY');
    } catch (unlockError) {
      const message = getErrorMessage(unlockError, 'Cloud share unlock failed');
      setError(message);
      setStatus(
        message === 'Password required' || message === 'Invalid password'
          ? 'PASSWORD_REQUIRED'
          : 'ERROR'
      );
    }
  };

  const glassPanelClass =
    'bg-black/40 backdrop-blur-2xl border border-emerald-500/20 rounded-[2rem] shadow-[0_0_40px_rgba(0,0,0,0.3)] overflow-hidden';

  return (
    <div className="flex flex-col items-center justify-center h-full w-full px-4 py-6 md:px-0 z-10 relative">
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
            <h2 className="text-2xl font-bold text-red-300 mb-3">
              Drop Unavailable
            </h2>
            <p className="text-sm text-gray-300">{error}</p>
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
            <h2 className="text-2xl font-bold text-white mb-3">
              Password Required
            </h2>
            <p className="text-sm text-gray-400 mb-5">
              Enter the password from the sender to open this Cloud Drop.
            </p>
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              className="w-full bg-gray-950/70 border border-gray-700 focus:border-emerald-400 outline-none rounded-xl px-4 py-3 text-white mb-3"
              autoComplete="current-password"
              autoFocus
            />
            {error === 'Invalid password' && (
              <p className="text-sm text-red-300 mb-3">Invalid password.</p>
            )}
            <button
              type="submit"
              disabled={!password.trim()}
              className="w-full py-3 rounded-xl bg-emerald-500/20 border border-emerald-400/50 text-emerald-100 font-bold tracking-wider disabled:opacity-40 disabled:cursor-not-allowed"
            >
              UNLOCK DROP
            </button>
          </motion.form>
        )}

        {status === 'READY' && share && (
          <motion.div
            key="cloud-ready"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`w-full max-w-2xl p-6 md:p-8 ${glassPanelClass}`}
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
                  <h2 className="text-2xl md:text-4xl font-bold brand-font text-white truncate">
                    {share.rootName}
                  </h2>
                  <p className="text-sm text-gray-400 font-mono mt-2">
                    {share.totalFiles} files • {formatBytes(share.totalSize)}
                  </p>
                </div>
              </div>

              <div className="text-left md:text-right text-xs font-mono text-gray-500">
                <p>Expires {expiryLabel}</p>
                <p>{Math.floor(share.secondsUntilExpiry / 3600)}h remaining</p>
              </div>
            </div>

            {!share.completed && (
              <div className="bg-yellow-900/30 border border-yellow-500/30 rounded-2xl p-4 text-yellow-100 text-sm mb-5">
                Sender upload is still finishing. Refresh this page shortly.
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
                    <p className="text-sm font-bold text-white truncate">
                      {file.name}
                    </p>
                    <p className="text-xs text-gray-500 font-mono truncate">
                      {file.path} • {formatBytes(file.size)}
                    </p>
                  </div>
                  <a
                    href={getCloudDownloadUrl(
                      share.shareId,
                      file.id,
                      downloadSessionToken || share.downloadSessionToken
                    )}
                    className={`w-11 h-11 rounded-xl flex items-center justify-center border transition-all ${
                      share.completed
                        ? 'bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20 text-emerald-300'
                        : 'bg-gray-800/40 border-gray-700/50 text-gray-600 pointer-events-none'
                    }`}
                    aria-label={`Download ${file.name}`}
                  >
                    <Download className="w-5 h-5" />
                  </a>
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
