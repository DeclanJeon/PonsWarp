import type { TransferEvent, TransferRole, TransferTerminalReason } from './events';

export type TransferStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'transferring'
  | 'reconnecting'
  | 'completed'
  | 'cancelled'
  | 'timed_out'
  | 'error';

export interface TransferState {
  readonly role: TransferRole;
  readonly status: TransferStatus;
  readonly totalBytes: number;
  /** Bytes sent over transport (sender progress). */
  readonly transportBytes: number;
  /** Bytes durably written (receiver progress). */
  readonly persistedBytes: number;
  /** Role-specific progress value. */
  readonly bytes: number;
  readonly seenChunks: ReadonlySet<string | number>;
  /** Transport connectivity is distinct from application/storage readiness. */
  readonly connected: boolean;
  readonly ready: boolean;
  readonly terminal: boolean;
  readonly terminalReason?: TransferTerminalReason;
  readonly error?: string;
  readonly lastEventAt?: number;
}

export interface TransferStateOptions {
  role: TransferRole;
  totalBytes?: number;
}

export function createTransferState(options: TransferStateOptions): TransferState {
  const totalBytes = Math.max(0, options.totalBytes ?? 0);
  return {
    role: options.role,
    status: 'idle',
    totalBytes,
    transportBytes: 0,
    persistedBytes: 0,
    connected: false,
    ready: false,
    bytes: 0,
    seenChunks: new Set(),
    terminal: false,
  };
}

export const initialTransferState = createTransferState({ role: 'sender' });
export const initialState = initialTransferState;

const terminalStatus = (event: TransferEvent): TransferStatus => {
  switch (event.type) {
    case 'complete': return 'completed';
    case 'cancel': return 'cancelled';
    case 'timeout': return 'timed_out';
    default: return 'error';
  }
};

const terminalReason = (event: TransferEvent): TransferTerminalReason => {
  switch (event.type) {
    case 'complete': return 'completed';
    case 'cancel': return 'cancelled';
    case 'timeout': return 'timeout';
    default: return 'error';
  }
};

/** Pure reducer. Events for another role and all events after a terminal are ignored. */
export function reduceTransferState(state: TransferState, event: TransferEvent): TransferState {
  if (event.role !== state.role || state.terminal) return state;
  const at = event.at === undefined ? state.lastEventAt : event.at;
  const base = { ...state, lastEventAt: at };

  switch (event.type) {
    case 'connect':
    case 'join':
      return { ...base, status: 'connecting' };
    case 'connected':
      return { ...base, connected: true };
    case 'ready':
      return { ...base, status: 'ready', ready: true };
    case 'reconnect':
      return { ...base, status: 'reconnecting', connected: false, ready: false };
    case 'resume': {
      const resumed = event.bytes === undefined ? state.bytes : Math.max(state.bytes, Math.max(0, event.bytes));
      return {
        ...base,
        status: 'transferring',
        bytes: resumed,
        transportBytes: state.role === 'sender' ? resumed : state.transportBytes,
        persistedBytes: state.role === 'receiver' ? resumed : state.persistedBytes,
      };
    }
    case 'duplicate-chunk': {
      const seenChunks = new Set(state.seenChunks);
      seenChunks.add(event.chunkId);
      return { ...base, seenChunks };
    }
    case 'progress': {
      const seenChunks = new Set(state.seenChunks);
      if (event.chunkId !== undefined && seenChunks.has(event.chunkId)) return { ...base, seenChunks };
      if (event.chunkId !== undefined) seenChunks.add(event.chunkId);
      const next = Math.min(Math.max(0, event.bytes), Math.max(state.totalBytes, event.totalBytes, event.bytes));
      return {
        ...base,
        status: 'transferring',
        totalBytes: Math.max(state.totalBytes, Math.max(0, event.totalBytes)),
        bytes: Math.max(state.bytes, next),
        transportBytes: state.role === 'sender' ? Math.max(state.transportBytes, next) : state.transportBytes,
        persistedBytes: state.role === 'receiver' ? Math.max(state.persistedBytes, next) : state.persistedBytes,
        seenChunks,
      };
    }
    case 'complete':
    case 'cancel':
    case 'timeout':
    case 'error':
      return {
        ...base,
        status: terminalStatus(event),
        terminal: true,
        connected: false,
        ready: false,
        terminalReason: terminalReason(event),
        error: 'error' in event ? event.error : undefined,
      };
  }
}

export const transferReducer = reduceTransferState;
