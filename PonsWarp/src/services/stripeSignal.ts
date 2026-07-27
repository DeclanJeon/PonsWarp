import { STRIPE_SEP } from './swarmStripe';

export function normalizeLaneSignal(raw: unknown): { signal: any; lane: number } {
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
      const { lane: _l, ...rest } = obj;
      return { signal: rest, lane: Number.isFinite(lane) ? lane : 0 };
    }
    return { signal: obj, lane: Number.isFinite(lane) ? lane : 0 };
  }
  return { signal: raw, lane: 0 };
}
