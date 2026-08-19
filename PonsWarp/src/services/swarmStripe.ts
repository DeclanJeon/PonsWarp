export const STRIPE_SEP = '::stripe::';

export function stripePeerKey(baseId: string, lane: number): string {
  return lane <= 0 ? baseId : `${baseId}${STRIPE_SEP}${lane}`;
}

export function parseStripePeerKey(peerKey: string): {
  baseId: string;
  lane: number;
} {
  const idx = peerKey.indexOf(STRIPE_SEP);
  if (idx < 0) return { baseId: peerKey, lane: 0 };
  const lane = Number(peerKey.slice(idx + STRIPE_SEP.length));
  return {
    baseId: peerKey.slice(0, idx),
    lane: Number.isFinite(lane) ? lane : 0,
  };
}

export function normalizeSignalPayload(raw: unknown): {
  signal: Record<string, unknown> | string | unknown;
  lane: number;
} {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { signal: raw, lane: 0 };
    }
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const lane = Number(obj.lane ?? 0);
    if ('lane' in obj) {
      const { lane: _lane, ...rest } = obj;
      void _lane;
      return {
        signal: rest,
        lane: Number.isFinite(lane) ? lane : 0,
      };
    }
    return { signal: obj, lane: Number.isFinite(lane) ? lane : 0 };
  }
  return { signal: raw, lane: 0 };
}
