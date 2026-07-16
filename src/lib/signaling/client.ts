import type { SignalingMessage, TransferFileMeta } from "@/lib/types";

export type SignalingHandlers = {
  onMessage?: (msg: SignalingMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
};

function defaultSignalingUrl(): string {
  if (typeof window === "undefined") return "ws://localhost:4001";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = process.env.NEXT_PUBLIC_SIGNALING_HOST || `${window.location.hostname}:4001`;
  if (process.env.NEXT_PUBLIC_SIGNALING_URL) return process.env.NEXT_PUBLIC_SIGNALING_URL;
  return `${proto}//${host}`;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers: SignalingHandlers = {};
  private url: string;
  private closedByUser = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(url = defaultSignalingUrl()) {
    this.url = url;
  }

  connect(handlers: SignalingHandlers = {}): Promise<void> {
    this.handlers = handlers;
    this.closedByUser = false;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        this.startPing();
        this.handlers.onOpen?.();
        resolve();
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as SignalingMessage;
          this.handlers.onMessage?.(msg);
        } catch {
          /* ignore malformed */
        }
      };
      ws.onerror = (ev) => {
        this.handlers.onError?.(ev);
        reject(new Error("시그널링 서버에 연결할 수 없습니다."));
      };
      ws.onclose = () => {
        this.stopPing();
        this.handlers.onClose?.();
      };
    });
  }

  send(message: SignalingMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  createSession(files: TransferFileMeta[] = []): void {
    this.send({ type: "create-session", role: "sender", files });
  }

  joinSession(code: string): void {
    this.send({ type: "join-session", code, role: "receiver" });
  }

  close(): void {
    this.closedByUser = true;
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: "ping" });
    }, 20000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export { defaultSignalingUrl };
