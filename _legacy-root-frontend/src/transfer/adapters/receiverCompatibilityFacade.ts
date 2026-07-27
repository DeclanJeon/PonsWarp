import type { ReceiverEvent } from '../events';

type ReceiverTransferEvent = ReceiverEvent;

export type ReceiverLegacyEventHandler = (data: unknown) => void;

export interface ReceiverCompatibilityFacadeOptions {
  emit?: (event: string, data: unknown) => void;
}

/**
 * Adapts the typed receiver transfer events to the event names and payloads
 * consumed by the original ReceiverService API.
 */
export class ReceiverCompatibilityFacade {
  private readonly listeners: Record<string, ReceiverLegacyEventHandler[]> = {};
  private readonly output?: (event: string, data: unknown) => void;
  private terminal = false;

  constructor(options: ReceiverCompatibilityFacadeOptions = {}) {
    this.output = options.emit;
  }

  on(event: string, handler: ReceiverLegacyEventHandler): void {
    (this.listeners[event] ??= []).push(handler);
  }

  off(event: string, handler: ReceiverLegacyEventHandler): void {
    this.listeners[event] = (this.listeners[event] ?? []).filter(item => item !== handler);
  }

  reset(): void {
    this.terminal = false;
  }

  handle(event: ReceiverTransferEvent, actualSize?: number): void {
    if (actualSize !== undefined && !Number.isFinite(actualSize)) return;
    if (this.terminal) return;
    switch (event.type) {
      case 'connect':
        this.emit('status', 'CONNECTING');
        break;
      case 'reconnect':
        if (event.attempt !== undefined && event.maxAttempts !== undefined &&
            Number.isFinite(event.attempt) && Number.isFinite(event.maxAttempts)) {
          this.emit('reconnecting', { attempt: event.attempt, maxAttempts: event.maxAttempts });
        }
        break;
      case 'resume':
        this.emit('progress', this.progress(event.bytes));
        break;
      case 'progress':
        // Receiver bytes are persisted bytes, not transport bytes.
        this.emit('progress', this.progress(event.bytes, event.totalBytes));
        break;
      case 'connected':
        this.emit('connected', true);
        break;
      case 'ready':
        this.emit('storage-ready', true);
        break;
      case 'complete':
        this.terminal = true;
        this.emit('complete', { actualSize });
        break;
      case 'timeout':
        this.terminal = true;
        this.emit('error', event.error ?? 'Transfer timed out');
        break;
      case 'cancel':
        this.terminal = true;
        this.emit('error', event.error ?? 'Transfer cancelled');
        break;
      case 'error':
        this.terminal = true;
        this.emit('error', event.error);
        break;
      case 'join':
        this.emit('status', 'CONNECTING');
        break;
      default:
        break;
    }
  }

  private progress(bytesTransferred?: number, totalBytes?: number) {
    const payload: { progress?: number; speed?: number; bytesTransferred?: number; totalBytes?: number } = {};
    if (bytesTransferred !== undefined) payload.bytesTransferred = bytesTransferred;
    if (totalBytes !== undefined) {
      payload.totalBytes = totalBytes;
      if (totalBytes > 0 && bytesTransferred !== undefined) payload.progress = bytesTransferred / totalBytes;
    }
    return payload;
  }

  private emit(event: string, data: unknown): void {
    for (const handler of this.listeners[event] ?? []) handler(data);
    this.output?.(event, data);
  }
}

export const mapReceiverEvent = (event: ReceiverTransferEvent, actualSize?: number): Array<{ event: string; data: unknown }> => {
  const result: Array<{ event: string; data: unknown }> = [];
  const facade = new ReceiverCompatibilityFacade({ emit: (name, data) => result.push({ event: name, data }) });
  facade.handle(event, actualSize);
  return result;
};
