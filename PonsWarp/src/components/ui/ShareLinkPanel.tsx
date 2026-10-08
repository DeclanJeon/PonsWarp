import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface ShareLinkPanelProps {
  link: string;
  code: string;
  displayCode?: string;
  codeLabel?: string;
}

export function ShareLinkPanel({ link, code, displayCode = code, codeLabel = 'Room code' }: ShareLinkPanelProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLElement>(null);
  const codeButtonRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async (target: 'link' | 'code') => {
    setCopied(null);
    setError(null);
    try {
      await navigator.clipboard.writeText(target === 'link' ? link : code);
      setCopied(target);
    } catch {
      if (target === 'link') {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (codeRef.current) {
        codeButtonRef.current?.focus();
        const range = document.createRange();
        range.selectNodeContents(codeRef.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setError(`Could not copy automatically. Select and copy the ${target === 'link' ? 'link' : codeLabel.toLowerCase()} manually.`);
    }
  };

  return (
    <div className="w-full min-w-0 space-y-3">
      <div className="rounded-xl border border-emerald-500/30 bg-gray-900/60 p-3 sm:p-4">
        <label htmlFor={inputId} className="mb-2 block text-sm font-bold text-emerald-200">Share link</label>
        <input id={inputId} ref={inputRef} type="text" readOnly value={link}
          onFocus={event => event.currentTarget.select()}
          className="min-h-11 w-full min-w-0 select-text rounded-lg border border-gray-600 bg-black/30 px-3 text-base text-white outline-none focus:border-emerald-300 focus:ring-2 focus:ring-emerald-400/40" />
        <button type="button" onClick={() => void copy('link')}
          className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-emerald-400 px-4 py-3 text-sm font-bold text-gray-950 transition-colors hover:bg-emerald-300">
          {copied === 'link' ? <Check size={18} /> : <Copy size={18} />}
          {copied === 'link' ? 'Link copied!' : 'Copy link'}
        </button>
      </div>
      {code && (
        <button ref={codeButtonRef} type="button" aria-label={`Copy ${codeLabel.toLowerCase()}`} onClick={() => void copy('code')}
          className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-emerald-500/5 p-3 text-left transition-colors hover:border-emerald-300 sm:p-4">
          <span className="min-w-0">
            <span className="mb-1 block text-sm text-gray-300">{codeLabel} — enter in Receive</span>
            <code ref={codeRef} className="block select-text break-all text-base font-bold tracking-wider text-white">{displayCode}</code>
          </span>
          {copied === 'code' ? <Check size={18} className="shrink-0 text-emerald-300" /> : <Copy size={18} className="shrink-0 text-emerald-300" />}
        </button>
      )}
      <p role="status" aria-live="polite" aria-atomic="true" className={`min-h-5 text-sm leading-5 ${error ? 'text-amber-200' : 'text-emerald-300'}`}>
        {error || (copied ? `${copied === 'link' ? 'Link' : codeLabel} copied to clipboard.` : '')}
      </p>
    </div>
  );
}
