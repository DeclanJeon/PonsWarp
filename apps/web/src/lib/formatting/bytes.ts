const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number, digits = 2): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0B";
  if (bytes === 0) return "0B";
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exp;
  const fixed = exp === 0 ? String(Math.round(value)) : value.toFixed(digits).replace(/\.?0+$/, "");
  return `${fixed}${UNITS[exp]}`;
}

export function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0B/s";
  return `${formatBytes(bps)}/s`;
}

export function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return "남은 시간을 계산하고 있습니다";
  }
  if (seconds < 1) return "거의 완료";
  if (seconds < 60) return `약 ${Math.ceil(seconds)}초 남음`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  if (mins < 60) return `약 ${mins}분 ${secs}초 남음`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `약 ${hours}시간 ${remMins}분 남음`;
}

export function formatPercent(progress: number): string {
  const p = Math.max(0, Math.min(100, progress * 100));
  if (p > 0 && p < 0.1) return "0.1%";
  if (p >= 99.95 && p < 100) return "99.9%";
  if (Number.isInteger(p) || p >= 10) return `${Math.round(p)}%`;
  return `${p.toFixed(1)}%`;
}

export function formatCodeDisplay(code: string): string {
  const clean = code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (clean.length <= 3) return clean;
  return `${clean.slice(0, 3)} ${clean.slice(3, 6)}`;
}
