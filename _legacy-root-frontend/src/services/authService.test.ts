import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAuthState } from './authService';

describe('getAuthState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to an anonymous state when the auth endpoint returns non-json HTML', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      }))
    );

    await expect(getAuthState()).resolves.toEqual({ authenticated: false });
  });

  it('returns the authenticated state from a valid response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          authenticated: true,
          user: {
            id: 'user-1',
            email: 'user@example.com',
          },
        }),
      }))
    );

    await expect(getAuthState()).resolves.toEqual({
      authenticated: true,
      user: {
        id: 'user-1',
        email: 'user@example.com',
      },
    });
  });
});
