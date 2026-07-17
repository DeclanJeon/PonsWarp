import { describe, expect, it } from 'vitest';
import { isCompleteRoomCode, normalizeRoomCodeInput } from './roomCode';

describe('room code normalization', () => {
  it('keeps manually typed room codes uppercase and six characters long', () => {
    expect(normalizeRoomCodeInput('abc123')).toBe('ABC123');
    expect(normalizeRoomCodeInput('abc123zzz')).toBe('ABC123');
    expect(normalizeRoomCodeInput('ab-c 12')).toBe('ABC12');
  });

  it('extracts the room code from full receive links instead of joining room HTTPS:', () => {
    expect(normalizeRoomCodeInput('https://warp.ponslink.com/receive/yiby9e')).toBe(
      'YIBY9E'
    );
    expect(
      normalizeRoomCodeInput('Open this: https://warp.ponslink.com/receive/S6X41K?x=1')
    ).toBe('S6X41K');
  });

  it('checks whether normalized input contains a complete room code', () => {
    expect(isCompleteRoomCode('https://warp.ponslink.com/receive/yiby9e')).toBe(true);
    expect(isCompleteRoomCode('abc12')).toBe(false);
  });
});
