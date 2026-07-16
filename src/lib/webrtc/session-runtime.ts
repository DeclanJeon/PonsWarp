import { TransferEngine, type SaveMode } from "@/lib/webrtc/transfer-engine";
import type { Role } from "@/lib/types";

const engines = new Map<Role, TransferEngine>();

const SEND_SESSION_KEY = "ponswarp.activeSendSession";

export type PersistedSendSession = {
  code: string;
  fileNames: string[];
  totalBytes: number;
  createdAt: number;
};

export function getTransferEngine(role: Role): TransferEngine {
  const existing = engines.get(role);
  if (existing && !existing.isDestroyed()) return existing;
  const engine = new TransferEngine(role);
  engines.set(role, engine);
  return engine;
}

export function destroyTransferEngine(role?: Role): void {
  if (role) {
    const engine = engines.get(role);
    engine?.destroy();
    engines.delete(role);
    if (role === "sender") clearPersistedSendSession();
    return;
  }
  for (const [key, engine] of engines) {
    engine.destroy();
    engines.delete(key);
  }
  clearPersistedSendSession();
}

export function persistSendSession(session: PersistedSendSession): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SEND_SESSION_KEY, JSON.stringify(session));
  } catch {
    /* ignore quota */
  }
}

export function readPersistedSendSession(): PersistedSendSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SEND_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedSendSession;
  } catch {
    return null;
  }
}

export function clearPersistedSendSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SEND_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export type { SaveMode };
