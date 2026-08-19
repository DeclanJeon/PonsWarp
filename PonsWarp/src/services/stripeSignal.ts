export function normalizeLaneSignal(raw: unknown): {
  signal: any;
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
      return { signal: rest, lane: Number.isFinite(lane) ? lane : 0 };
    }
    return { signal: obj, lane: Number.isFinite(lane) ? lane : 0 };
  }
  return { signal: raw, lane: 0 };
}
