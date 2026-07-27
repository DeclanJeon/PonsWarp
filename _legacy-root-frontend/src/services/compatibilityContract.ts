import manifestJson from '../../../contracts/compatibility/v1/manifest.json';

export type CompatibilityManifest = {
  contract: string;
  version: string;
  status: string;
  constructors: Array<Record<string, unknown>>;
  methods: Array<{ owner: string; name: string; signature: string }>;
  singletonExports: Array<Record<string, unknown>>;
  namedExports: Array<Record<string, unknown>>;
  events: Record<string, string[]>;
  eventPayloadSemantics: Record<string, unknown>;
  timeoutsAndRetries: Record<string, unknown>;
  roles: Record<string, string>;
  callsites: Array<Record<string, unknown>>;
};

const arraySections = ['constructors', 'methods', 'singletonExports', 'namedExports', 'callsites'] as const;
const objectSections = ['events', 'eventPayloadSemantics', 'timeoutsAndRetries', 'roles'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertEntryFields(value: unknown, section: string, index: number, fields: string[]): void {
  if (!isRecord(value) || fields.some(field => !isString(value[field]))) {
    throw new Error(`Compatibility manifest ${section} entry ${index} is malformed`);
  }
}

function assertUnique(values: string[], section: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Compatibility manifest contains duplicate ${section} names`);
  }
}

export function assertCompatibilityManifest(value: unknown): asserts value is CompatibilityManifest {
  if (!isRecord(value)) throw new Error('Compatibility manifest must be an object');
  for (const key of ['contract', 'version', 'status']) {
    if (!isString(value[key])) throw new Error(`Compatibility manifest requires string field: ${key}`);
  }
  for (const key of arraySections) {
    if (!Array.isArray(value[key])) throw new Error(`Compatibility manifest requires array section: ${key}`);
  }
  for (const key of objectSections) {
    if (!isRecord(value[key])) throw new Error(`Compatibility manifest requires object section: ${key}`);
  }

  (value.constructors as unknown[]).forEach((entry, index) => assertEntryFields(entry, 'constructor', index, ['module', 'export', 'kind']));
  (value.singletonExports as unknown[]).forEach((entry, index) => assertEntryFields(entry, 'singleton export', index, ['module', 'name', 'type']));
  (value.namedExports as unknown[]).forEach((entry, index) => assertEntryFields(entry, 'named export', index, ['module', 'name', 'type']));
  (value.callsites as unknown[]).forEach((entry, index) => assertEntryFields(entry, 'callsite', index, ['module', 'uses']));

  const methods = value.methods as unknown[];
  methods.forEach((method, index) => assertEntryFields(method, 'method', index, ['owner', 'name', 'signature']));
  assertUnique(methods.map(method => `${(method as Record<string, string>).owner}.${(method as Record<string, string>).name}`), 'API');

  const events = value.events as Record<string, unknown>;
  const eventNames: string[] = [];
  for (const [owner, names] of Object.entries(events)) {
    if (!isString(owner) || !Array.isArray(names) || names.some(name => !isString(name))) {
      throw new Error(`Compatibility manifest events for ${owner} are malformed`);
    }
    assertUnique(names as string[], `${owner} event`);
    eventNames.push(...(names as string[]).map(name => `${owner}.${name}`));
  }
  assertUnique(eventNames, 'event');

  const roles = value.roles as Record<string, unknown>;
  if (Object.entries(roles).some(([role, description]) => !isString(role) || !isString(description))) {
    throw new Error('Compatibility manifest roles are malformed');
  }
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    const cloned = value.map(item => cloneAndFreeze(item)) as T;
    return Object.freeze(cloned);
  }
  if (isRecord(value)) {
    const cloned = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)])) as T;
    return Object.freeze(cloned);
  }
  return value;
}

assertCompatibilityManifest(manifestJson);
export const compatibilityManifest: CompatibilityManifest = cloneAndFreeze(manifestJson);

export function loadCompatibilityManifest(): CompatibilityManifest {
  return cloneAndFreeze(JSON.parse(JSON.stringify(compatibilityManifest)) as CompatibilityManifest);
}
