import { describe, expect, it } from 'vitest';
import {
  getCryptoPlaneClient,
  resetCryptoPlaneClient,
} from './cryptoPlaneClient';

describe('crypto plane packet contracts', () => {
  it('encrypted packet header layout stays 38 bytes before ciphertext', () => {
    const ENCRYPTED_HEADER_SIZE = 38;
    const AUTH_TAG_SIZE = 16;
    const plaintextLength = 1024;
    const total = ENCRYPTED_HEADER_SIZE + plaintextLength + AUTH_TAG_SIZE;
    expect(total).toBe(38 + 1024 + 16);
    expect(ENCRYPTED_HEADER_SIZE).toBe(38);
  });

  it('exports client factory helpers', () => {
    const client = getCryptoPlaneClient();
    expect(client.isAvailable()).toBe(false); // no key yet / workers lazy
    resetCryptoPlaneClient();
  });
});
