import { describe, expect, it } from 'vitest';
import {
  formatCloudShareCode,
  normalizeCloudShareCodeInput,
} from './cloudShareCode';

describe('cloud share code normalization', () => {
  it('accepts raw Cloud Drop share IDs as receive codes', () => {
    expect(normalizeCloudShareCodeInput('a1b2c3d4e5f6')).toBe('A1B2C3D4E5F6');
    expect(normalizeCloudShareCodeInput('a1b2-c3d4')).toBe('A1B2-C3D4');
  });

  it('extracts Cloud Drop codes from full cloud links', () => {
    expect(
      normalizeCloudShareCodeInput(
        'https://warp.ponslink.com/cloud/a1b2c3d4e5f6?utm=qr'
      )
    ).toBe('A1B2C3D4E5F6');
  });

  it('does not treat six-character P2P room codes as cloud codes', () => {
    expect(normalizeCloudShareCodeInput('ABC123')).toBeNull();
  });

  it.each(['NOT A VALID CODE', 'https://warp.ponslink.com/receive/ABC123', 'Open https://warp.ponslink.com/cloud/a1b2c3d4', 'https://warp.ponslink.com/cloud/a1b2c3d4/extra', 'javascript:/cloud/a1b2c3d4'])('rejects malformed codes and links: %s', input => {
    expect(normalizeCloudShareCodeInput(input)).toBeNull();
  });

  it('accepts the displayed grouped code without losing its identifier', () => {
    const id = 'a1b2c3d4e5f6';
    expect(normalizeCloudShareCodeInput(formatCloudShareCode(id))).toBe(id.toUpperCase());
  });

});
