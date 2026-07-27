import initPonsCore from 'pons-core-wasm';
type Sha256StreamLike = {
  update(data: Uint8Array): void;
  finalize(): Uint8Array;
  reset(): void;
  free(): void;
};
type GeneratedWasmModule = {
  Sha256Stream?: new () => Sha256StreamLike;
};

const BRIDGE_ENABLED = import.meta.env.VITE_LAN_EVIDENCE_BRIDGE === 'true';
const FSA_ENABLED = import.meta.env.VITE_LAN_EVIDENCE_FSA === 'true';
export const EVIDENCE_READBACK_CHUNK_BYTES = 131072;
const MAX_BODY_BYTES = 128 * 1024;

type EvidenceRole = 'sender' | 'receiver';
export type EvidencePhase =
  | 'IDLE'
  | 'ARMED'
  | 'READY'
  | 'ROOM_READY'
  | 'RECEIVER_READY'
  | 'STARTED'
  | 'QUEUED'
  | 'ACCEPTED'
  | 'COMMITTED'
  | 'FINALIZING'
  | 'FINALIZED'
  | 'ERROR';

export interface EvidenceBridgeIdentity {
  runId: string;
  runNonce: string;
  role: EvidenceRole;
  bridgePort: number;
  bridgeToken: string;
  origin: string;
  armDigest: string;
  profileName: 'lan256' | 'lan1g';
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface EvidenceFsaHandleContext {
  readonly handle: FileSystemFileHandle;
  readonly runId: string;
  readonly runNonce: string;
  readonly bridgeToken: string;
  readonly armDigest?: string;
  readonly expiresAtMs: number;
  readonly verified: boolean;
  consume(): void;
  release(): void;
}

export interface EvidenceStartCommand {
  type: 'START';
  pipelineOn: boolean;
  certificateId?: string;
  certificateDigest: string | null;
  armDigest: string;
  certificateExpiresAtMs?: number;
  runId: string;
  runNonce: string;
  profile: 'lan256' | 'lan1g';
  browser: string;
  hostPair: { senderId: string; receiverId: string };
  signalingUrl: string;
  control: 'on' | 'off';
}

export interface EvidenceTelemetry {
  phase: EvidencePhase;
  atMs: number;
  bytes?: number;
  totalBytes?: number;
  details?: Record<string, unknown>;
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized =
    value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = atob(normalized);
  return Uint8Array.from(decoded, c => c.charCodeAt(0));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        key =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
async function hmac(token: string, value: unknown): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const bytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(canonical(value))
  );
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const PROFILE_DEADLINE_MS = {
  lan256: 30 * 60 * 1000,
  lan1g: 90 * 60 * 1000,
} as const;
const MAX_TOKEN_LIFETIME_MS = 95 * 60 * 1000;

export function parseEvidenceIdentity(
  hash = typeof location === 'undefined' ? '' : location.hash
): EvidenceBridgeIdentity | null {
  if (!BRIDGE_ENABLED || !hash.startsWith('#lanEvidence=')) return null;
  try {
    const value = JSON.parse(
      new TextDecoder().decode(
        base64UrlDecode(hash.slice('#lanEvidence='.length))
      )
    ) as Partial<EvidenceBridgeIdentity>;
    const profile = value.profileName;
    if (
      !value ||
      typeof value !== 'object' ||
      !['sender', 'receiver'].includes(value.role as string) ||
      !Number.isInteger(value.bridgePort) ||
      value.bridgePort < 1024 ||
      value.bridgePort > 65535 ||
      typeof value.runId !== 'string' ||
      value.runId.length === 0 ||
      value.runId.length > 128 ||
      typeof value.runNonce !== 'string' ||
      value.runNonce.length === 0 ||
      value.runNonce.length > 256 ||
      typeof value.bridgeToken !== 'string' ||
      value.bridgeToken.length < 16 ||
      value.bridgeToken.length > 512 ||
      typeof value.origin !== 'string' ||
      value.origin !== `http://localhost:${value.bridgePort}` ||
      typeof value.armDigest !== 'string' ||
      value.armDigest.length === 0 ||
      value.armDigest.length > 256 ||
      !['lan256', 'lan1g'].includes(profile as string) ||
      typeof value.issuedAtMs !== 'number' ||
      !Number.isFinite(value.issuedAtMs) ||
      value.issuedAtMs <= 0 ||
      typeof value.expiresAtMs !== 'number' ||
      !Number.isFinite(value.expiresAtMs) ||
      value.expiresAtMs <= value.issuedAtMs ||
      value.expiresAtMs - value.issuedAtMs > MAX_TOKEN_LIFETIME_MS ||
      value.expiresAtMs >
        value.issuedAtMs +
          PROFILE_DEADLINE_MS[profile as 'lan256' | 'lan1g'] +
          5 * 60 * 1000 ||
      value.expiresAtMs <= Date.now()
    )
      return null;
    return value as EvidenceBridgeIdentity;
  } catch {
    return null;
  }
}

export function createEvidenceFsaHandleContext(
  identity: EvidenceBridgeIdentity,
  handle: FileSystemFileHandle
): EvidenceFsaHandleContext {
  let active = true;
  const expiresAtMs = identity.expiresAtMs;
  const assertLive = () => {
    if (!active || !identity.runId || Date.now() >= expiresAtMs)
      throw new Error('Evidence FSA handle expired or released');
  };
  return {
    handle,
    runId: identity.runId,
    runNonce: identity.runNonce,
    bridgeToken: identity.bridgeToken,
    armDigest: identity.armDigest,
    expiresAtMs,
    get verified() {
      return active && FSA_ENABLED && Date.now() < expiresAtMs;
    },
    consume() {
      assertLive();
    },
    release() {
      active = false;
    },
  };
}

export async function hashFileBounded(file: Blob): Promise<string> {
  await initPonsCore();
  const wasm =
    (await import('pons-core-wasm')) as unknown as GeneratedWasmModule;
  const Stream = wasm.Sha256Stream;
  if (!Stream) throw new Error('Canonical WASM SHA-256 stream is unavailable');
  const stream = new Stream();
  try {
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
      const chunk = new Uint8Array(
        await file
          .slice(offset, Math.min(offset + 1024 * 1024, file.size))
          .arrayBuffer()
      );
      stream.update(chunk);
    }
    const digest = stream.finalize();
    return Array.from(digest)
      .map(v => v.toString(16).padStart(2, '0'))
      .join('');
  } finally {
    stream.reset();
    stream.free();
  }
}

export class LanEvidenceAdapter {
  private readonly identity: EvidenceBridgeIdentity | null;
  private eventAbort: AbortController | null = null;
  private commandSequence = 0;
  private reportSequence = 0;
  private phase: EvidencePhase = 'IDLE';
  private readonly telemetryListeners = new Set<
    (event: EvidenceTelemetry) => void
  >();
  private handleContext: EvidenceFsaHandleContext | null = null;
  private readonly commandListeners = new Set<
    (command: Record<string, unknown>) => void
  >();

  constructor(identity = parseEvidenceIdentity()) {
    this.identity = identity;
    if (
      typeof window !== 'undefined' &&
      window.history &&
      window.location.hash.startsWith('#lanEvidence=')
    ) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}`
      );
    }
  }
  get enabled(): boolean {
    return BRIDGE_ENABLED && this.identity !== null;
  }
  get role(): EvidenceRole | null {
    return this.identity?.role ?? null;
  }
  get currentPhase(): EvidencePhase {
    return this.phase;
  }
  get fsaHandleContext(): EvidenceFsaHandleContext | null {
    return this.handleContext;
  }
  onTelemetry(listener: (event: EvidenceTelemetry) => void): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }
  onCommand(listener: (command: Record<string, unknown>) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }
  private setPhase(
    phase: EvidencePhase,
    details?: Record<string, unknown>
  ): void {
    this.phase = phase;
    const event = { phase, atMs: Date.now(), details };
    this.telemetryListeners.forEach(listener => listener(event));
  }
  private url(path: string): string {
    const identity = this.getIdentity();
    return `http://127.0.0.1:${identity.bridgePort}${path}`;
  }
  private headers(): HeadersInit {
    const identity = this.getIdentity();
    return {
      Authorization: `Bearer ${identity.bridgeToken}`,
      'Content-Type': 'application/json',
    };
  }
  private getIdentity(): EvidenceBridgeIdentity {
    const identity = this.identity;
    if (
      !this.enabled ||
      !identity ||
      identity.bridgePort < 1024 ||
      identity.bridgePort > 65535 ||
      identity.origin !== `http://localhost:${identity.bridgePort}` ||
      !identity.armDigest ||
      !['lan256', 'lan1g'].includes(identity.profileName) ||
      !Number.isFinite(identity.issuedAtMs) ||
      identity.issuedAtMs <= 0 ||
      !Number.isFinite(identity.expiresAtMs) ||
      identity.expiresAtMs <= identity.issuedAtMs ||
      identity.expiresAtMs - identity.issuedAtMs >
        (identity.profileName === 'lan1g' ? 95 : 35) * 60 * 1000 ||
      Date.now() >= identity.expiresAtMs
    )
      throw new Error('LAN evidence identity is expired or invalid');
    return identity;
  }
  private validateStartCommand(
    command: Record<string, unknown>,
    identity: EvidenceBridgeIdentity
  ): void {
    if (command.type !== 'START') return;
    const payload =
      command.payload && typeof command.payload === 'object'
        ? (command.payload as Record<string, unknown>)
        : command;
    const hex64 = /^[0-9a-f]{64}$/i;
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const pipelineOn = payload.pipelineOn === true || payload.control === 'on';
    const pair = payload.hostPair;
    if (
      payload.runId !== identity.runId ||
      payload.runNonce !== identity.runNonce ||
      !['lan256', 'lan1g'].includes(String(payload.profile)) ||
      typeof payload.browser !== 'string' ||
      !payload.browser ||
      typeof payload.signalingUrl !== 'string' ||
      !/^wss?:\/\/[^/?#]+(?::\d{1,5})?\/ws$/.test(payload.signalingUrl) ||
      !['on', 'off'].includes(String(payload.control)) ||
      typeof payload.armDigest !== 'string' ||
      payload.armDigest !== identity.armDigest ||
      !hex64.test(payload.armDigest) ||
      !pair ||
      typeof pair !== 'object' ||
      typeof (pair as Record<string, unknown>).senderId !== 'string' ||
      typeof (pair as Record<string, unknown>).receiverId !== 'string'
    )
      throw new Error('Evidence START binding is malformed');
    if (pipelineOn) {
      if (
        typeof payload.certificateId !== 'string' ||
        !uuid.test(payload.certificateId) ||
        typeof payload.certificateDigest !== 'string' ||
        !hex64.test(payload.certificateDigest) ||
        typeof payload.certificateExpiresAtMs !== 'number' ||
        !Number.isFinite(payload.certificateExpiresAtMs) ||
        payload.certificateExpiresAtMs <= Date.now() ||
        payload.certificateExpiresAtMs > Date.now() + 30 * 60 * 1000
      )
        throw new Error('Evidence START certificate binding is malformed');
    }
  }

  async hello(): Promise<void> {
    const identity = this.getIdentity();
    const response = await fetch(this.url('/v1/evidence/hello'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        runId: identity.runId,
        runNonce: identity.runNonce,
        role: identity.role,
      }),
    });
    if (!response.ok)
      throw new Error(`Evidence bridge hello failed: ${response.status}`);
    this.setPhase('ARMED');
  }

  async listen(
    onCommand: (command: Record<string, unknown>) => void
  ): Promise<void> {
    const identity = this.getIdentity();
    this.eventAbort?.abort();
    this.eventAbort = new AbortController();
    const response = await fetch(this.url('/v1/evidence/events'), {
      headers: {
        Authorization: `Bearer ${identity.bridgeToken}`,
        Accept: 'text/event-stream',
      },
      signal: this.eventAbort.signal,
    });
    if (!response.ok || !response.body)
      throw new Error(`Evidence event stream failed: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamDone = false;
    try {
      while (!streamDone) {
        if (Date.now() >= identity.expiresAtMs)
          throw new Error('LAN evidence identity expired');
        const { value, done } = await reader.read();
        if (done) {
          streamDone = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const records = buffer.split('\n\n');
        buffer = records.pop() || '';
        for (const record of records) {
          const line = record
            .split('\n')
            .find(item => item.startsWith('data:'));
          if (!line) continue;
          const command = JSON.parse(line.slice(5).trim()) as Record<
            string,
            unknown
          >;
          if (
            command.runId !== identity.runId ||
            command.runNonce !== identity.runNonce ||
            command.commandSeq !== this.commandSequence + 1
          )
            throw new Error('Evidence command sequence or identity mismatch');
          const mac = String(command.bridgeMac || '');
          const unsigned = { ...command };
          delete unsigned.bridgeMac;
          const expected = await hmac(identity.bridgeToken, unsigned);
          if (
            !constantTimeEqual(
              new TextEncoder().encode(mac),
              new TextEncoder().encode(expected)
            )
          )
            throw new Error('Evidence command authentication failed');
          this.commandSequence++;
          this.validateStartCommand(command, identity);
          onCommand(command);
          this.commandListeners.forEach(listener => listener(command));
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  async report(
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<void> {
    const identity = this.getIdentity();
    if (JSON.stringify(payload).length > MAX_BODY_BYTES)
      throw new Error('Evidence report exceeds bounded body size');
    const body = {
      runId: identity.runId,
      runNonce: identity.runNonce,
      role: identity.role,
      reportSeq: ++this.reportSequence,
      type,
      payload,
    };
    const response = await fetch(this.url('/v1/evidence/report'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        ...body,
        mac: await hmac(identity.bridgeToken, body),
      }),
    });
    if (!response.ok)
      throw new Error(`Evidence report failed: ${response.status}`);
  }
  async readbackChunk(
    index: number,
    offset: number,
    length: number,
    expectedSha256?: string
  ): Promise<Uint8Array> {
    const identity = this.getIdentity();
    if (
      !Number.isInteger(index) ||
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      index < 0 ||
      offset < 0 ||
      length < 0 ||
      length > EVIDENCE_READBACK_CHUNK_BYTES
    )
      throw new Error('invalid readback chunk');
    const body = {
      runId: identity.runId,
      runNonce: identity.runNonce,
      role: identity.role,
      index,
      offset,
      length,
      readbackSeq: index + 1,
    };
    const response = await fetch(this.url('/v1/evidence/readback-chunk'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        ...body,
        mac: await hmac(identity.bridgeToken, body),
      }),
    });
    if (!response.ok)
      throw new Error(`Evidence readback failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > EVIDENCE_READBACK_CHUNK_BYTES || bytes.length !== length)
      throw new Error('invalid readback size');
    if (expectedSha256) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const actual = Array.from(new Uint8Array(digest))
        .map(v => v.toString(16).padStart(2, '0'))
        .join('');
      if (actual !== expectedSha256)
        throw new Error('readback digest mismatch');
    }
    return bytes;
  }
  async uploadSavedFileReadback({
    artifactId,
    expectedSize,
    expectedSha256,
  }: {
    artifactId: string;
    expectedSize: number;
    expectedSha256?: string;
  }): Promise<void> {
    const identity = this.getIdentity(),
      context = this.handleContext;
    if (
      !context?.verified ||
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      !artifactId
    )
      throw new Error('verified held FSA handle required');
    try {
      const file = await context.handle.getFile();
      if (file.size !== expectedSize) throw new Error('readback size mismatch');
      const sourceDigest = await hashFileBounded(file);
      if (expectedSha256 && sourceDigest !== expectedSha256)
        throw new Error('source digest mismatch');
      for (
        let offset = 0, index = 0;
        offset < expectedSize;
        index++, offset += EVIDENCE_READBACK_CHUNK_BYTES
      ) {
        if (!context.verified) throw new Error('evidence token expired');
        const length = Math.min(
          EVIDENCE_READBACK_CHUNK_BYTES,
          expectedSize - offset
        );
        const chunk = new Uint8Array(
          await file.slice(offset, offset + length).arrayBuffer()
        );
        const chunkSha256 = await hashFileBounded(new Blob([chunk]));
        const metadata = {
          artifactId,
          index,
          offset,
          length,
          chunkSha256,
          runId: identity.runId,
          runNonce: identity.runNonce,
          role: identity.role,
          seq: index + 1,
        };
        const response = await fetch(this.url('/v1/evidence/readback-chunk'), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${identity.bridgeToken}`,
            'Content-Type': 'application/octet-stream',
            'X-Evidence-Artifact': artifactId,
            'X-Evidence-Index': String(index),
            'X-Evidence-Offset': String(offset),
            'X-Evidence-Length': String(length),
            'X-Evidence-Chunk-Sha256': chunkSha256,
            'X-Evidence-Run-Id': identity.runId,
            'X-Evidence-Run-Nonce': identity.runNonce,
            'X-Evidence-Role': identity.role,
            'X-Evidence-Seq': String(index + 1),
            'X-Evidence-Mac': await hmac(identity.bridgeToken, metadata),
          },
          body: chunk,
        });
        if (!response.ok)
          throw new Error(`Evidence readback failed: ${response.status}`);
      }
      await this.report('COMMITTED', {
        artifactId,
        expectedSize,
        sourceSha256: sourceDigest,
      });
      await this.report('FINALIZED', {
        artifactId,
        expectedSize,
        sourceSha256: sourceDigest,
      });
    } catch (error) {
      this.handleContext?.release();
      this.handleContext = null;
      throw error;
    }
  }
  async pickReceiverSaveHandle(
    fileName: string
  ): Promise<EvidenceFsaHandleContext | null> {
    if (!this.enabled || !FSA_ENABLED) return null;
    const identity = this.getIdentity();
    if (identity.role !== 'receiver') return null;
    const picker = (
      window as Window & {
        showSaveFilePicker?: (
          options?: unknown
        ) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;
    if (!picker) throw new Error('Evidence FSA is unavailable');
    const handle = await picker({ suggestedName: fileName });
    const context = createEvidenceFsaHandleContext(identity, handle);
    this.setEvidenceFsaHandle(context);
    return context;
  }

  async reportPhase(
    phase: EvidencePhase,
    payload: Record<string, unknown> = {}
  ): Promise<void> {
    this.setPhase(phase, payload);
    if (this.enabled) await this.report(phase, payload);
  }

  setEvidenceFsaHandle(context: EvidenceFsaHandleContext): void {
    const identity = this.getIdentity();
    if (
      context.runId !== identity.runId ||
      context.runNonce !== identity.runNonce ||
      context.bridgeToken !== identity.bridgeToken ||
      !context.verified
    )
      throw new Error('Evidence FSA handle identity mismatch');
    this.handleContext = context;
  }
  async release(): Promise<void> {
    this.eventAbort?.abort();
    this.eventAbort = null;
    this.handleContext?.release();
    this.handleContext = null;
  }
}

export const lanEvidenceAdapter = new LanEvidenceAdapter();
