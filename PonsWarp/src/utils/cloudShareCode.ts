const CLOUD_ROUTE_PATTERN = /^\/cloud\/([a-z0-9-]{8,80})$/i;
const CLOUD_CODE_PATTERN = /^[A-Z0-9-]{8,80}$/;

export const normalizeCloudShareCodeInput = (input: string): string | null => {
  const trimmed = input.trim();
  if (CLOUD_CODE_PATTERN.test(trimmed.toUpperCase())) return trimmed.toUpperCase();
  if (/^(?:[a-z0-9-]{4} )+[a-z0-9-]{1,4}$/i.test(trimmed)) {
    const normalized = trimmed.replace(/ /g, '').toUpperCase();
    return CLOUD_CODE_PATTERN.test(normalized) ? normalized : null;
  }
  if (!/^(https?:\/\/|\/cloud\/)/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, 'https://warp.ponslink.com');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.pathname.match(CLOUD_ROUTE_PATTERN)?.[1].toUpperCase() || null;
  } catch {
    return null;
  }
};

export const formatCloudShareCode = (shareId: string): string =>
  shareId.toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
