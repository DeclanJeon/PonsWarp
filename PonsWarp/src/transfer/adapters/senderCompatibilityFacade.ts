import type { TransferEvent } from '../events';
type SenderTransferEvent = TransferEvent & { role: 'sender' };

function isSenderEvent(event: TransferEvent): event is SenderTransferEvent {
  return event.role === 'sender';
}

export type SenderEventName =
  | 'peer-connected'
  | 'status'
  | 'peer-ready'
  | 'progress'
  | 'reconnect'
  | 'resume'
  | 'duplicate-chunk'
  | 'peer-timeout'
  | 'transfer-failed'
  | 'cancel'
  | 'complete';

export interface SenderEventSource {
  on(event: string, handler: (event: TransferEvent) => void): void;
  off?(event: string, handler: (event: TransferEvent) => void): void;
}
const CORE_EVENTS: TransferEvent['type'][] = [
  'connect',
  'join',
  'connected',
  'ready',
  'progress',
  'reconnect',
  'resume',
  'duplicate-chunk',
  'timeout',
  'cancel',
  'error',
  'complete',
];

export interface SenderEventTarget {
  emit(event: string, payload?: unknown): void;
}

/**
 * Boundary adapter for old sender consumers. The core event remains typed and
 * the original progress values are forwarded verbatim (in particular, no
 * percentage calculation or clamping is performed here).
 */
export class SenderCompatibilityFacade {
  private readonly handler = (event: TransferEvent): void => {
    if (!isSenderEvent(event)) return;
    const mapped = mapSenderEvent(event);
    if (mapped) this.target.emit(mapped.name, mapped.payload);
  };

  constructor(
    private readonly source: SenderEventSource,
    private readonly target: SenderEventTarget
  ) {}

  attach(): this {
    CORE_EVENTS.forEach(type => this.source.on(type, this.handler));
    return this;
  }

  detach(): this {
    CORE_EVENTS.forEach(type => this.source.off?.(type, this.handler));
    return this;
  }
}

export function mapSenderEvent(event: SenderTransferEvent): {
  name: SenderEventName;
  payload?: unknown;
} | null {
  switch (event.type) {
    case 'connect':
      return { name: 'status', payload: 'CONNECTING' };
    case 'join':
      return { name: 'status', payload: 'WAITING_FOR_PEER' };
    case 'connected':
      return { name: 'peer-connected', payload: event };
    case 'ready':
      return { name: 'peer-ready', payload: event };
    case 'progress':
      // Keep transport progress untouched; consumers own presentation math.
      return { name: 'progress', payload: event };
    case 'reconnect':
      return { name: 'reconnect', payload: event };
    case 'resume':
      return { name: 'resume', payload: event };
    case 'duplicate-chunk':
      return { name: 'duplicate-chunk', payload: event };
    case 'timeout':
      return { name: 'peer-timeout', payload: event.error ?? event };
    case 'cancel':
      return { name: 'cancel', payload: event.error ?? event };
    case 'error':
      return { name: 'transfer-failed', payload: event.error };
    case 'complete':
      return { name: 'complete', payload: event };
    default:
      return null;
  }
}

export function createSenderCompatibilityFacade(
  source: SenderEventSource,
  target: SenderEventTarget
): SenderCompatibilityFacade {
  return new SenderCompatibilityFacade(source, target);
}
