import { describe, expect, it } from 'vitest';
import {
  computePrepareAheadCount,
  computePartitionSendCap,
  computeScaledInFlightTargetBytes,
  hasOpenSendBudget,
  resolveActivePartitionSize,
  shouldSkipPartitionAckBarrier,
} from './swarmTransferLoop';

describe('swarmTransferLoop pure helpers', () => {
  it('bounds prepare-ahead packet slots from memory budget', () => {
    // 12 MiB / 256 KiB = 48 → clamped inside [16, 128]
    expect(computePrepareAheadCount(256 * 1024, 12 * 1024 * 1024)).toBe(48);
    // tiny chunks still clamp to max 128
    expect(computePrepareAheadCount(1024, 12 * 1024 * 1024)).toBe(128);
    // huge chunks still keep at least 16
    expect(computePrepareAheadCount(2 * 1024 * 1024, 12 * 1024 * 1024)).toBe(
      16
    );
  });

  it('scales in-flight target only when stripe is armed', () => {
    expect(
      computeScaledInFlightTargetBytes({
        baseInFlightBytes: 4 * 1024 * 1024,
        stripeEnabled: false,
        lanStripeLanes: 1,
        verifiedStripeKeyCount: 3,
      })
    ).toBe(4 * 1024 * 1024);

    expect(
      computeScaledInFlightTargetBytes({
        baseInFlightBytes: 4 * 1024 * 1024,
        stripeEnabled: true,
        lanStripeLanes: 3,
        verifiedStripeKeyCount: 2,
      })
    ).toBe(8 * 1024 * 1024);

    expect(
      computeScaledInFlightTargetBytes({
        baseInFlightBytes: 16 * 1024 * 1024,
        stripeEnabled: true,
        lanStripeLanes: 4,
        verifiedStripeKeyCount: 4,
        maxBytes: 24 * 1024 * 1024,
      })
    ).toBe(24 * 1024 * 1024);
  });

  it('computes partition send cap with lane factor', () => {
    expect(
      computePartitionSendCap({
        inFlightTargetBytes: 6 * 1024 * 1024,
        stripeEnabled: false,
        lanStripeLanes: 1,
        verifiedStripeKeyCount: 3,
      })
    ).toBe(6 * 1024 * 1024);

    expect(
      computePartitionSendCap({
        inFlightTargetBytes: 6 * 1024 * 1024,
        stripeEnabled: true,
        lanStripeLanes: 3,
        verifiedStripeKeyCount: 2,
      })
    ).toBe(6 * 1024 * 1024);
  });

  it('disables partition barriers on host/unknown/relay', () => {
    expect(
      resolveActivePartitionSize({
        pathKind: 'host',
        stripeEnabled: false,
        lanStripeLanes: 1,
        lanStripePartitionBytes: 4 * 1024 * 1024,
        profilePartitionSize: 8 * 1024 * 1024,
      })
    ).toBe(Number.MAX_SAFE_INTEGER);

    expect(
      resolveActivePartitionSize({
        pathKind: 'relay',
        stripeEnabled: false,
        lanStripeLanes: 1,
        lanStripePartitionBytes: 4 * 1024 * 1024,
        profilePartitionSize: 8 * 1024 * 1024,
      })
    ).toBe(Number.MAX_SAFE_INTEGER);

    expect(
      resolveActivePartitionSize({
        pathKind: 'srflx',
        stripeEnabled: false,
        lanStripeLanes: 1,
        lanStripePartitionBytes: 4 * 1024 * 1024,
        profilePartitionSize: 8 * 1024 * 1024,
      })
    ).toBe(8 * 1024 * 1024);

    expect(
      resolveActivePartitionSize({
        pathKind: 'srflx',
        stripeEnabled: true,
        lanStripeLanes: 3,
        lanStripePartitionBytes: 4 * 1024 * 1024,
        profilePartitionSize: 8 * 1024 * 1024,
      })
    ).toBe(4 * 1024 * 1024);
  });

  it('skips partition ACK barrier on host/unknown/relay only', () => {
    expect(shouldSkipPartitionAckBarrier('host')).toBe(true);
    expect(shouldSkipPartitionAckBarrier('unknown')).toBe(true);
    expect(shouldSkipPartitionAckBarrier('relay')).toBe(true);
    expect(shouldSkipPartitionAckBarrier('srflx')).toBe(false);
  });

  it('treats any positive send budget as open', () => {
    expect(hasOpenSendBudget(1)).toBe(true);
    expect(hasOpenSendBudget(0)).toBe(false);
    expect(hasOpenSendBudget(-1)).toBe(false);
  });
});
