const RECEIVE_ROUTE_PATTERN = /^\/receive\/([a-z0-9]{6})$/i;

export const normalizeRoomCodeInput = (input: string): string => {
  const trimmed = input.trim();
  if (/^[a-z0-9]{6}$/i.test(trimmed)) return trimmed.toUpperCase();
  if (!/^(https?:\/\/|\/receive\/)/i.test(trimmed)) return '';
  try {
    const url = new URL(trimmed, 'https://warp.ponslink.com');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.pathname.match(RECEIVE_ROUTE_PATTERN)?.[1].toUpperCase() || '';
  } catch {
    return '';
  }
};

export const isCompleteRoomCode = (input: string): boolean =>
  /^[A-Z0-9]{6}$/.test(normalizeRoomCodeInput(input));
