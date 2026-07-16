import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.SIGNALING_PORT || 4001);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000);
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** @type {Map<string, any>} */
const sessionsByCode = new Map();
/** @type {Map<string, any>} */
const sessionsById = new Map();

function generateCode(length = 6) {
  let out = "";
  const bytes = randomBytes(length);
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function generateId() {
  return randomBytes(12).toString("hex");
}

function send(ws, message) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function purgeExpired() {
  const now = Date.now();
  for (const [code, session] of sessionsByCode) {
    if (session.expiresAt <= now) {
      cleanupSession(session, "expired");
      sessionsByCode.delete(code);
    }
  }
}

function cleanupSession(session, reason = "closed") {
  for (const role of ["sender", "receiver"]) {
    const peer = session.peers[role];
    if (peer) {
      send(peer, { type: "error", code: reason, message: reason === "expired" ? "세션이 만료되었습니다." : "세션이 종료되었습니다." });
      try {
        peer.close();
      } catch {
        /* ignore */
      }
    }
  }
  sessionsById.delete(session.id);
}

function getPeerRole(session, ws) {
  if (session.peers.sender === ws) return "sender";
  if (session.peers.receiver === ws) return "receiver";
  return null;
}

function otherRole(role) {
  return role === "sender" ? "receiver" : "sender";
}

setInterval(purgeExpired, 15_000).unref?.();

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "warpspace-signaling", sessions: sessionsByCode.size }));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  /** @type {{ sessionId?: string, role?: string }} */
  ws.meta = {};

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, { type: "error", code: "bad-json", message: "잘못된 메시지 형식입니다." });
      return;
    }

    if (msg.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }

    if (msg.type === "create-session") {
      purgeExpired();
      let code = generateCode();
      while (sessionsByCode.has(code)) code = generateCode();
      const id = generateId();
      const expiresAt = Date.now() + SESSION_TTL_MS;
      const session = {
        id,
        code,
        expiresAt,
        files: Array.isArray(msg.files) ? msg.files : [],
        peers: { sender: ws, receiver: null },
      };
      sessionsByCode.set(code, session);
      sessionsById.set(id, session);
      ws.meta = { sessionId: id, role: "sender" };
      send(ws, { type: "session-created", sessionId: id, code, expiresAt });
      return;
    }

    if (msg.type === "join-session") {
      purgeExpired();
      const code = String(msg.code || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6);
      const session = sessionsByCode.get(code);
      if (!session) {
        send(ws, { type: "error", code: "not-found", message: "코드를 다시 확인해 주세요." });
        return;
      }
      if (session.expiresAt <= Date.now()) {
        send(ws, { type: "error", code: "expired", message: "이 전송 공간은 만료되었습니다." });
        return;
      }
      if (session.peers.receiver && session.peers.receiver.readyState === 1) {
        send(ws, { type: "error", code: "busy", message: "이미 수신자가 접속한 전송 공간입니다." });
        return;
      }
      session.peers.receiver = ws;
      ws.meta = { sessionId: session.id, role: "receiver" };
      send(ws, {
        type: "session-joined",
        sessionId: session.id,
        code: session.code,
        files: session.files,
        expiresAt: session.expiresAt,
      });
      send(session.peers.sender, { type: "peer-joined", role: "receiver" });
      return;
    }

    const session = ws.meta.sessionId ? sessionsById.get(ws.meta.sessionId) : null;
    if (!session) {
      send(ws, { type: "error", code: "no-session", message: "세션이 없습니다." });
      return;
    }

    const role = getPeerRole(session, ws);
    if (!role) return;
    const target = session.peers[otherRole(role)];

    if (msg.type === "files-updated") {
      session.files = Array.isArray(msg.files) ? msg.files : session.files;
      if (target) send(target, { type: "files-updated", files: session.files });
      return;
    }

    if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice-candidate" || msg.type === "reject") {
      if (target) send(target, msg);
      else send(ws, { type: "error", code: "peer-missing", message: "상대방이 아직 접속하지 않았습니다." });
      return;
    }
  });

  ws.on("close", () => {
    const session = ws.meta.sessionId ? sessionsById.get(ws.meta.sessionId) : null;
    if (!session) return;
    const role = getPeerRole(session, ws);
    if (!role) return;
    session.peers[role] = null;
    const other = session.peers[otherRole(role)];
    if (other) send(other, { type: "peer-left", role });
    if (!session.peers.sender && !session.peers.receiver) {
      sessionsByCode.delete(session.code);
      sessionsById.delete(session.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[warpspace-signaling] ws://localhost:${PORT}`);
});
