import { describe, it, expect } from 'vitest';
import {
  classifyCloudShareError,
  formatCloudShareError,
} from './cloudShareErrors';

describe('cloudShareErrors mapper', () => {
  it('maps 401/403 to password', () => {
    expect(formatCloudShareError(new Error('HTTP 401'))).toBe(
      'Password required or incorrect.'
    );
    expect(classifyCloudShareError(new Error('http 403')).code).toBe(
      'password'
    );
  });

  it('maps 404 to not-found', () => {
    expect(
      formatCloudShareError(new Error('Request failed with HTTP 404'))
    ).toBe('Share not found or expired.');
  });

  it('maps 413/429/5xx', () => {
    expect(formatCloudShareError(new Error('HTTP 413'))).toContain('too large');
    expect(formatCloudShareError(new Error('http 429'))).toContain('wait');
    expect(formatCloudShareError(new Error('HTTP 503'))).toContain(
      'Server error'
    );
  });

  it('maps network TypeError', () => {
    expect(formatCloudShareError(new TypeError('fetch failed'))).toContain(
      'Network error'
    );
  });

  it('falls back to unknown', () => {
    expect(formatCloudShareError(new Error('random'))).toBe(
      'Unexpected error. Please try again.'
    );
  });
});
