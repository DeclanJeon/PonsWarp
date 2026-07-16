type Handler = (data: unknown) => void;

export type PonsWarpTurnConfig = {
  success: boolean;
  data?: {
    iceServers: RTCIceServer[];
    ttl?: number;
    timestamp?: number;
    roomId?: string;
  };
  error?: string | null;
  message?: string;
};

function defaultUrl(): string {
  if (typeof window === "undefined") return "ws://localhost:5502/ws";
  if (process.env.NEXT_PUBLIC_PONSWARP_SIGNALING_URL) {
    return process.env.NEXT_PUBLIC_PONSWARP_SIGNALING_URL;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = process.env.NEXT_PUBLIC_PONSWARP_SIGNALING_HOST || `${window.location.hostname}:5502`;
  return `${proto}//${host}/ws`;
}

function toSnakePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    out[snake] = value;
  }
  return out;
}

function toCamel(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(toCamel);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[camel] = toCamel(v);
  }
  return out;
}

/**
 * PonsWarp Rust signaling client (contracts/protocol/v1).
 * Wire: { type, payload } over native WebSocket /ws
 */
export class PonsWarpSignalingClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler[]>();
  private socketId: string | null = null;
  private url: string;
  private connectPromise: Promise<void> | null = null;
  private closedByUser = false;

  constructor(url = defaultUrl()) {
    this.url = url;
  }

  getServerUrl(): string {
    return this.url;
  }

  getSocketId(): string | null {
    return this.socketId;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.closedByUser = false;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.connectPromise = promise;

    const ws = new WebSocket(this.url);
    this.ws = ws;
    const timeout = setTimeout(() => {
      reject(new Error("PonsWarp 시그널링 연결 시간 초과"));
      this.connectPromise = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }, 8000);

    ws.onopen = () => {
      /* wait for Connected frame */
    };

    ws.onmessage = (ev) => {
      try {
        const message = JSON.parse(String(ev.data)) as { type: string; payload?: unknown };
        if (message.type === "Connected") {
          clearTimeout(timeout);
          const payload = toCamel(message.payload) as { socketId?: string };
          this.socketId = payload.socketId ?? null;
          this.emit("connected", this.socketId);
          resolve();
          this.connectPromise = null;
          return;
        }
        this.dispatch(message.type, message.payload);
      } catch {
        /* ignore malformed */
      }
    };

    ws.onerror = () => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timeout);
        reject(new Error("PonsWarp 시그널링 서버에 연결할 수 없습니다."));
        this.connectPromise = null;
      }
    };

    ws.onclose = () => {
      this.emit("disconnect", { reason: "closed" });
      this.socketId = null;
      this.connectPromise = null;
      if (!this.closedByUser) this.emit("connection-failed", new Error("signaling closed"));
    };

    return promise;
  }

  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  off(event: string, handler: Handler): void {
    const list = this.handlers.get(event);
    if (!list) return;
    this.handlers.set(
      event,
      list.filter((h) => h !== handler),
    );
  }

  joinRoom(roomId: string): void {
    this.send("JoinRoom", { roomId });
  }

  leaveRoom(): void {
    this.send("LeaveRoom", {});
  }

  sendOffer(roomId: string, offer: RTCSessionDescriptionInit, target?: string | null): void {
    this.send("Offer", {
      roomId,
      sdp: JSON.stringify(offer),
      target: target ?? null,
    });
  }

  sendAnswer(roomId: string, answer: RTCSessionDescriptionInit, target?: string | null): void {
    this.send("Answer", {
      roomId,
      sdp: JSON.stringify(answer),
      target: target ?? null,
    });
  }

  sendCandidate(roomId: string, candidate: RTCIceCandidateInit | null, target?: string | null): void {
    this.send("IceCandidate", {
      roomId,
      candidate: JSON.stringify(candidate),
      target: target ?? null,
    });
  }

  requestTurnConfig(roomId: string): Promise<PonsWarpTurnConfig> {
    const { promise, resolve } = Promise.withResolvers<PonsWarpTurnConfig>();
    const timeout = setTimeout(() => {
      this.off("turn-config", handler);
      resolve({ success: false, error: "timeout", message: "TURN config timeout" });
    }, 4000);

    const handler = (data: unknown) => {
      clearTimeout(timeout);
      this.off("turn-config", handler);
      resolve(data as PonsWarpTurnConfig);
    };
    this.on("turn-config", handler);
    this.send("RequestTurnConfig", { roomId, forceRefresh: false });
    return promise;
  }

  close(): void {
    this.closedByUser = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.socketId = null;
    this.connectPromise = null;
  }

  private send(type: string, payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type, payload: toSnakePayload(payload) }));
  }

  private dispatch(type: string, payload: unknown): void {
    const eventMap: Record<string, string> = {
      HeartbeatAck: "heartbeat-ack",
      JoinedRoom: "joined-room",
      RoomUsers: "room-users",
      PeerJoined: "peer-joined",
      UserLeft: "user-left",
      RoomFull: "room-full",
      Offer: "offer",
      Answer: "answer",
      IceCandidate: "ice-candidate",
      TurnConfig: "turn-config",
      Error: "error",
      Manifest: "manifest",
      TransferReady: "transfer-ready",
      TransferComplete: "transfer-complete",
    };

    const eventName = eventMap[type] ?? type.toLowerCase();
    const camel = toCamel(payload);
    if (camel && typeof camel === "object") {
      const obj = camel as Record<string, unknown>;
      if (type === "Offer" && obj.sdp != null) obj.offer = parseMaybeJson(obj.sdp);
      if (type === "Answer" && obj.sdp != null) obj.answer = parseMaybeJson(obj.sdp);
      if (type === "IceCandidate" && obj.candidate != null) {
        obj.candidate = parseMaybeJson(obj.candidate);
      }
      if (type === "TurnConfig" && obj.data && typeof obj.data === "object") {
        const data = obj.data as Record<string, unknown>;
        if (data.iceServers == null && data.ice_servers != null) data.iceServers = data.ice_servers;
      }
    }
    this.emit(eventName, camel);
  }

  private emit(event: string, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function generatePonsWarpRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export { defaultUrl as defaultPonsWarpSignalingUrl };
