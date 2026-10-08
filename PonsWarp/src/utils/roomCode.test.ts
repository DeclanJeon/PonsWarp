import { describe, expect, it } from 'vitest';
import { isCompleteRoomCode, normalizeRoomCodeInput } from './roomCode';

describe('receive room input', () => {
  it.each([' abc123 ', 'https://warp.ponslink.com/receive/abc123?from=qr', '/receive/abc123'])('accepts an exact code or receive URL: %s', input => {
    expect(normalizeRoomCodeInput(input)).toBe('ABC123');
    expect(isCompleteRoomCode(input)).toBe(true);
  });
  it.each(['abc123zzz', 'ab-c 12', 'NOT A VALID CODE', 'https://warp.ponslink.com/cloud/ABC123', 'Open this: https://warp.ponslink.com/receive/ABC123', 'https://warp.ponslink.com/receive/ABC123/extra', 'javascript:/receive/ABC123', 'abc12'])('rejects invalid input without truncating: %s', input => {
    expect(normalizeRoomCodeInput(input)).toBe('');
    expect(isCompleteRoomCode(input)).toBe(false);
  });
});
