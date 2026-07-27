const RECEIVE_ROUTE_PATTERN = /\/receive\/([a-z0-9]{6})(?:[^a-z0-9]|$)/i;

export const normalizeRoomCodeInput = (input: string): string => {
  const trimmed = input.trim();
  const receiveRouteMatch = trimmed.match(RECEIVE_ROUTE_PATTERN);

  if (receiveRouteMatch) {
    return receiveRouteMatch[1].toUpperCase();
  }

  return trimmed.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6);
};

export const isCompleteRoomCode = (input: string): boolean =>
  /^[A-Z0-9]{6}$/.test(normalizeRoomCodeInput(input));
