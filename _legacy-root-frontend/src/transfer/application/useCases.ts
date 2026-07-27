import type { TransferEvent, TransferRole } from '../events';
import { reduceTransferState, createTransferState, type TransferState } from '../state';
import type { CloudDropPort, ClockPort, PeerPort, TransferPorts, WriterPort } from '../ports';

export interface TransferRunnerOptions { role: TransferRole; totalBytes?: number; ports: TransferPorts; timeoutMs?: number; }
export interface TransferRunner {
  readonly state: TransferState;
  readonly events: ReadonlyArray<TransferEvent>;
  connect(): Promise<void>; join(roomId: string): Promise<void>; resume(bytes?: number): void; reconnect(): Promise<void>;
  progress(bytes: number, totalBytes?: number, chunkId?: string | number): Promise<void>;
  sendChunk(data: unknown, bytes: number, chunkId?: string | number, offset?: number): Promise<void>;
  complete(): Promise<void>; cancel(error?: string): Promise<void>; timeout(error?: string): void; error(message: string): void; close(): Promise<void>;
}
const defaultClock: ClockPort = { now: () => Date.now(), setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
const finite = (value: number | undefined): value is number => value === undefined || Number.isFinite(value);

export function createTransferRunner(options: TransferRunnerOptions): TransferRunner {
  if (!finite(options.totalBytes) || !finite(options.timeoutMs)) throw new TypeError('Numeric options must be finite');
  if (options.role === 'receiver' && !options.ports.writer) throw new TypeError('A writer is required for receiver execution');
  let current = createTransferState({ role: options.role, totalBytes: options.totalBytes });
  const events: TransferEvent[] = [];
  let peer: PeerPort | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeClose: (() => void) | undefined;
  let timer: unknown;
  let teardownPromise: Promise<void> | undefined;
  let connected = false;
  let closed = false;
  let terminated = false;
  let writeQueue: Promise<void> = Promise.resolve();
  const pendingWrites = new Set<string | number>();
  const teardown = async () => {
    if (teardownPromise) return teardownPromise;
    teardownPromise = (async () => {
      unsubscribe?.(); unsubscribe = undefined;
      unsubscribeClose?.(); unsubscribeClose = undefined;
      const ownedPeer = peer; peer = undefined; connected = false;
      await ownedPeer?.close?.();
      await writeQueue.catch(() => undefined);
      await options.ports.writer?.close?.();
      await options.ports.signaling.leave?.();
    })();
    return teardownPromise;
  };
  const clock = options.ports.clock ?? defaultClock;
  const output = options.ports.output;
  const dispatch = (event: TransferEvent) => {
    if (closed || event.role !== options.role || current.terminal) return;
    const before = current; current = reduceTransferState(current, event);
    if (current === before) return;
    events.push(event); output?.emit(event); output?.setState?.(current);
  };
  const clearTimer = () => { if (timer !== undefined) { clock.clearTimeout(timer); timer = undefined; } };
  const terminate = async (type: 'timeout' | 'cancel' | 'error', error?: string) => {
    if (terminated) return;
    clearTimer();
    const event = type === 'error'
      ? { type, role: options.role, error: error ?? 'Transfer failed', at: clock.now() }
      : { type, role: options.role, error, at: clock.now() };
    dispatch(event as TransferEvent);
    terminated = true; closed = true; pendingWrites.clear();
    await teardown();
  };
  const armTimeout = () => { clearTimer(); if (options.timeoutMs && options.timeoutMs > 0) timer = clock.setTimeout(() => { void terminate('timeout', 'Transfer timed out'); }, options.timeoutMs); };
  const bindPeer = (p: PeerPort) => {
    peer = p;
    unsubscribe = p.onMessage(message => {
      if (closed || terminated || current.terminal || !message || typeof message !== 'object') return;
      const m = message as Record<string, unknown>;
      if (m.type === 'chunk' && options.role === 'receiver') {
        if (typeof m.bytes !== 'number' || !Number.isFinite(m.bytes)) return;
        const id = typeof m.chunkId === 'string' || typeof m.chunkId === 'number' ? m.chunkId : undefined;
        if (id !== undefined && (current.seenChunks.has(id) || pendingWrites.has(id))) { dispatch({ type: 'duplicate-chunk', role: options.role, chunkId: id, at: clock.now() }); return; }
        if (id !== undefined) pendingWrites.add(id);
        const write = async () => {
          if (terminated) return;
          await options.ports.writer!.write(m.data, typeof m.offset === 'number' && Number.isFinite(m.offset) ? m.offset : undefined);
          if (!terminated) await runner.progress(m.bytes as number, typeof m.totalBytes === 'number' && Number.isFinite(m.totalBytes) ? m.totalBytes : undefined, id);
        };
        writeQueue = writeQueue.then(write, write);
        writeQueue.catch(error => { if (id !== undefined) pendingWrites.delete(id); if (!terminated) runner.error(error instanceof Error ? error.message : String(error)); });
        writeQueue = writeQueue.then(() => { if (id !== undefined) pendingWrites.delete(id); }, () => { if (id !== undefined) pendingWrites.delete(id); });
      } else if (m.type === 'progress' && typeof m.bytes === 'number' && Number.isFinite(m.bytes)) void runner.progress(m.bytes, typeof m.totalBytes === 'number' && Number.isFinite(m.totalBytes) ? m.totalBytes : undefined, m.chunkId as string | number | undefined);
      else if (m.type === 'complete') void runner.complete().catch(error => runner.error(error instanceof Error ? error.message : String(error)));
      else if (m.type === 'resume' && (m.bytes === undefined || (typeof m.bytes === 'number' && Number.isFinite(m.bytes)))) runner.resume(m.bytes as number | undefined);
    });
    if (p.onClose) unsubscribeClose = p.onClose(() => { if (!closed) { connected = false; clearTimer(); dispatch({ type: 'reconnect', role: options.role, at: clock.now() }); } });
  };
  const establish = async (kind: 'connect' | 'join', room?: string) => {
    if (connected || closed) return;
    try {
      dispatch({ type: kind, role: options.role, at: clock.now() });
      if (kind === 'connect') await options.ports.signaling.connect(); else await options.ports.signaling.join(room!);
      if (!peer) bindPeer(await options.ports.peer.create());
      await peer!.connect();
      connected = true;
      dispatch({ type: 'connected', role: options.role, at: clock.now() });
      if (options.role === 'sender') dispatch({ type: 'ready', role: options.role, at: clock.now() });
      armTimeout();
    } catch (error) { connected = false; clearTimer(); throw error; }
  };
  const runner: TransferRunner = {
    get state() { return current; }, get events() { return events; },
    connect: () => establish('connect'), join: room => establish('join', room),
    sendChunk: async (data, bytes, chunkId, offset) => { if (!Number.isFinite(bytes) || !finite(offset)) throw new TypeError('Numeric values must be finite'); if (!peer || !connected) throw new Error('Transfer peer is not connected'); await peer.send({ type: 'chunk', data, bytes, chunkId, offset, totalBytes: current.totalBytes }); await runner.progress(bytes, current.totalBytes, chunkId); },
    resume: bytes => { if (finite(bytes)) dispatch({ type: 'resume', role: options.role, bytes, at: clock.now() }); },
    reconnect: async () => { connected = false; if (peer) { unsubscribe?.(); unsubscribeClose?.(); await peer.close?.(); peer = undefined; } dispatch({ type: 'reconnect', role: options.role, at: clock.now() }); await establish('connect'); },
    progress: async (bytes, totalBytes = current.totalBytes, chunkId) => { if (!Number.isFinite(bytes) || !Number.isFinite(totalBytes)) throw new TypeError('Numeric values must be finite'); if (chunkId !== undefined && current.seenChunks.has(chunkId)) { dispatch({ type: 'duplicate-chunk', role: options.role, chunkId, at: clock.now() }); return; } dispatch({ type: 'progress', role: options.role, bytes, totalBytes, chunkId, at: clock.now() }); armTimeout(); },
    complete: async () => {
      try {
        await writeQueue;
        await options.ports.writer?.flush?.();
        await options.ports.writer?.close?.();
        clearTimer();
        dispatch({ type: 'complete', role: options.role, at: clock.now() });
      } catch (error) {
        runner.error(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    cancel: async error => { await terminate('cancel', error); },
    timeout: error => { void terminate('timeout', error); },
    error: message => { void terminate('error', message); },
    close: async () => { if (closed) return; closed = true; terminated = true; clearTimer(); await teardown(); },
  };
  return runner;
}
export const createSenderUseCase = (ports: TransferPorts, totalBytes = 0, timeoutMs?: number) => createTransferRunner({ role: 'sender', ports, totalBytes, timeoutMs });
export type ReceiverTransferPorts = Omit<TransferPorts, 'writer'> & { writer: WriterPort };
export const createReceiverUseCase = (ports: ReceiverTransferPorts, totalBytes = 0, timeoutMs?: number) => createTransferRunner({ role: 'receiver', ports, totalBytes, timeoutMs });
export interface CloudDropUseCase { create(input: unknown): Promise<unknown>; upload(shareId: string, data: unknown, offset?: number): Promise<unknown>; complete(shareId: string): Promise<unknown>; cancel(shareId: string): Promise<void>; }
export function createCloudDropUseCase(port: CloudDropPort): CloudDropUseCase {
  return {
    create: input => port.create(input),
    upload: (id, data, offset) => {
      if (!finite(offset)) throw new TypeError('Numeric values must be finite');
      return port.upload(id, data, offset);
    },
    complete: id => port.complete(id),
    cancel: id => port.cancel(id),
  };
}
export const createCloudDropRunner = createCloudDropUseCase;
