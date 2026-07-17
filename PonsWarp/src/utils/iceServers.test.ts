import { describe, expect, it } from 'vitest';
import { orderIceServersPreferDirect } from './iceServers';

describe('orderIceServersPreferDirect', () => {
  it('puts STUN before TURN', () => {
    const ordered = orderIceServersPreferDirect([
      { urls: 'turn:example.com' },
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: ['turns:example.com', 'turn:example.com'] },
    ]);
    expect(String(ordered[0].urls)).toContain('stun:');
    expect(String(ordered.at(-1)?.urls)).toContain('turn');
  });

  it('handles empty input', () => {
    expect(orderIceServersPreferDirect([])).toEqual([]);
    expect(orderIceServersPreferDirect(null)).toEqual([]);
  });
});
