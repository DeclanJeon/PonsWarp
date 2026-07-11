import { describe, expect, it } from 'vitest';
import {
  assertCompatibilityManifest,
  compatibilityManifest,
  loadCompatibilityManifest,
} from './compatibilityContract';

describe('compatibility v1 contract metadata', () => {
  it('loads the versioned immutable manifest and required sections', () => {
    const manifest = loadCompatibilityManifest();

    expect(manifest.contract).toBe('ponswarp-compatibility');
    expect(manifest.version).toBe('v1');
    expect(manifest.status).toBe('immutable-baseline');
    expect(manifest.constructors.length).toBeGreaterThan(0);
    expect(manifest.methods.length).toBeGreaterThan(0);
    expect(manifest.singletonExports.length).toBeGreaterThan(0);
    expect(Object.keys(manifest.events).length).toBeGreaterThan(0);
    expect(Object.keys(manifest.eventPayloadSemantics).length).toBeGreaterThan(0);
    expect(Object.keys(manifest.timeoutsAndRetries).length).toBeGreaterThan(0);
    expect(Object.keys(manifest.roles)).toEqual(expect.arrayContaining(['sender', 'receiver']));
    expect(manifest.callsites.length).toBeGreaterThan(0);
  });

  it('keeps API and event names unique', () => {
    const apiNames = compatibilityManifest.methods.map(method => `${method.owner}.${method.name}`);
    const eventNames = Object.entries(compatibilityManifest.events).flatMap(([owner, names]) =>
      names.map(name => `${owner}.${name}`)
    );

    expect(new Set(apiNames).size).toBe(apiNames.length);
    expect(new Set(eventNames).size).toBe(eventNames.length);
    expect(apiNames).toContain('SwarmManager.initSender');
    expect(apiNames).toContain('ReceiverService.startReceiving');
    expect(eventNames).toContain('SwarmManager.progress');
    expect(eventNames).toContain('transferService.progress');
  });

  it('fails closed for malformed or duplicate metadata', () => {
    expect(() => assertCompatibilityManifest({})).toThrow();
    expect(() =>
      assertCompatibilityManifest({
        ...compatibilityManifest,
        methods: [
          { owner: 'Example', name: 'run', signature: '() => void' },
          { owner: 'Example', name: 'run', signature: '() => void' },
        ],
      })
    ).toThrow(/duplicate API names/);
  });
  it('validates constructor, singleton, named export, and callsite entries', () => {
    for (const section of ['constructors', 'singletonExports', 'namedExports', 'callsites'] as const) {
      const malformed = { ...compatibilityManifest, [section]: [{ ...compatibilityManifest[section][0], module: '' }] };
      expect(() => assertCompatibilityManifest(malformed)).toThrow(/malformed/);
    }
  });

  it('returns an isolated recursively frozen baseline', () => {
    const loaded = loadCompatibilityManifest();

    expect(loaded).not.toBe(compatibilityManifest);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.methods)).toBe(true);
    expect(Object.isFrozen(loaded.methods[0])).toBe(true);
    expect(() => (loaded.methods[0].name = 'mutated')).toThrow();
    expect(compatibilityManifest.methods[0].name).not.toBe('mutated');
  });
});
