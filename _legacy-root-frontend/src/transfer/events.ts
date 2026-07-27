export type TransferRole = 'sender' | 'receiver';

export type TransferTerminalReason =
  | 'completed'
  | 'cancelled'
  | 'timeout'
  | 'error';

type TransferEventForRole<R extends TransferRole> =
  | { type: 'connect'; role: R; at?: number }
  | { type: 'connected'; role: R; at?: number }
  | { type: 'join'; role: R; at?: number }
  | { type: 'ready'; role: R; at?: number }
  | { type: 'progress'; role: R; bytes: number; totalBytes: number; chunkId?: string | number; at?: number }
  | { type: 'reconnect'; role: R; attempt?: number; maxAttempts?: number; at?: number }
  | { type: 'resume'; role: R; bytes?: number; at?: number }
  | { type: 'duplicate-chunk'; role: R; chunkId: string | number; at?: number }
  | { type: 'timeout'; role: R; error?: string; at?: number }
  | { type: 'cancel'; role: R; error?: string; at?: number }
  | { type: 'error'; role: R; error: string; at?: number }
  | { type: 'complete'; role: R; at?: number };

export type SenderEvent = TransferEventForRole<'sender'>;
export type ReceiverEvent = TransferEventForRole<'receiver'>;
export type TransferEvent = SenderEvent | ReceiverEvent;
export type TransferEventType = TransferEvent['type'];

export const isTerminalEvent = (event: TransferEvent): boolean =>
  event.type === 'complete' ||
  event.type === 'cancel' ||
  event.type === 'timeout' ||
  event.type === 'error';
