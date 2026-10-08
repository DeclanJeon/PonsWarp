import { describe, it, expect } from 'vitest';
import { CloudShareApiError, classifyCloudShareError } from './cloudShareErrors';

describe('Cloud Share API error contract', () => {
  it.each([401, 403])('preserves authentication status %s despite server wording', status => {
    const error = new CloudShareApiError(status, 'Password required');
    expect(error.status).toBe(status);
    expect(classifyCloudShareError(error).code).toBe('password');
  });

  it.each([[404, 'not-found'], [410, 'not-found'], [413, 'too-large'], [429, 'rate-limit'], [503, 'server']] as const)(
    'preserves HTTP %s as %s despite arbitrary error body', (status, code) => {
      expect(classifyCloudShareError(new CloudShareApiError(status, 'untranslated server detail')).code).toBe(code);
    }
  );

  it('distinguishes connection failures from unknown failures', () => {
    expect(classifyCloudShareError(new TypeError('Failed to fetch')).code).toBe('network');
    expect(classifyCloudShareError(new Error('other')).code).toBe('unknown');
  });
});
