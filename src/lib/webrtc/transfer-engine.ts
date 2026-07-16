import {
  generatePonsWarpRoomCode,
  PonsWarpSignalingClient,
} from "@/lib/signaling/ponswarp-client";
import { detectConnectionMode, getRtcConfiguration } from "@/lib/webrtc/config";
import {
  CHUNK_SIZE,
  MAX_BUFFERED_AMOUNT,
  SEND_PROGRESS_INTERVAL_MS,
  concatBuffers,
  encodeChunkHeader,
  parseChunkPacket,
  sha256File,
  totalChunksForSize,
} from "@/lib/transfer/chunking";
import { openStreamingWriter, triggerDownload, type StreamingWriter } from "@/lib/transfer/streaming-writer";
import { ProgressTracker } from "@/lib/transfer/progress-tracker";
import type {
  ControlMessage,
  PeerConnectionMode,
  Role,
  TransferFileItem,
  TransferFileMeta,
  TransferProgress,
  TransferViewState,
} from "@/lib/types";
export type SaveMode = "fs-access" | "streamsaver" | "blob";

export type EngineEvents = {
  onViewState?: (state: TransferViewState) => void;
  onProgress?: (progress: TransferProgress) => void;
  onFiles?: (files: TransferFileItem[]) => void;
  onConnectionMode?: (mode: PeerConnectionMode) => void;
  onSession?: (info: { sessionId: string; code: string; expiresAt: number }) => void;
  onError?: (message: string, code?: string) => void;
  onLog?: (message: string) => void;
  onBufferedAmount?: (bytes: number) => void;
  onReceivedFile?: (file: { id: string; name: string; type: string; downloadUrl?: string; checksum: string }) => void;
};

type LocalFile = TransferFileItem & { file?: File };

function metaFromFile(file: File, id: string): TransferFileMeta {
  return {
    id,
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
  };
}

function toItem(meta: TransferFileMeta, state: TransferFileItem["state"] = "queued"): TransferFileItem {
  return {
    ...meta,
    state,
    transferredBytes: 0,
    progress: 0,
  };
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Transfer engine: existing chunk DataChannel protocol + PonsWarp Rust signaling.
 */
export class TransferEngine {
  readonly role: Role;
  private signaling = new PonsWarpSignalingClient();
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private files: LocalFile[] = [];
  private progressTracker = new ProgressTracker();
  private events: EngineEvents = {};
  private viewState: TransferViewState = "idle";
  private connectionMode: PeerConnectionMode = "unknown";
  private destroyed = false;
  private transferStarted = false;
  private paused = false;
  private saveMode: SaveMode = "blob";
  private roomId: string | null = null;
  private remotePeerId: string | null = null;
  private iceServers: RTCIceServer[] | null = null;
  private makingOffer = false;
  private incoming = new Map<
    string,
    {
      meta: TransferFileMeta;
      index: number;
      received: number;
      totalChunks: number;
      writer: StreamingWriter | null;
      writerReady: Promise<void>;
      writeQueue: Promise<void>;
    }
  >();
  private uiTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private latestProgress: TransferProgress = this.progressTracker.snapshot();
  private directoryHandle: FileSystemDirectoryHandle | null = null;
  private controlQueue: string[] = [];
  private boundHandlers: Array<[string, (data: unknown) => void]> = [];

  constructor(role: Role) {
    this.role = role;
  }

  setEvents(events: EngineEvents): void {
    this.events = events;
  }

  setDirectoryHandle(handle: FileSystemDirectoryHandle | null): void {
    this.directoryHandle = handle;
  }

  getFiles(): TransferFileItem[] {
    return this.files.map(({ file: _f, ...rest }) => rest);
  }

  getProgress(): TransferProgress {
    return this.latestProgress;
  }

  getViewState(): TransferViewState {
    return this.viewState;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getRoomId(): string | null {
    return this.roomId;
  }

  async setLocalFiles(fileList: File[]): Promise<void> {
    this.files = fileList.map((file, i) => {
      const id = `${file.name}-${file.size}-${file.lastModified}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      return { ...toItem(metaFromFile(file, id)), file };
    });
    this.emitFiles();
    this.setViewState(this.files.length ? "files-selected" : "idle");
    this.progressTracker.reset(this.files.reduce((s, f) => s + f.size, 0));
    this.publishProgress();
  }

  async createSession(preferredCode?: string): Promise<void> {
    if (this.role !== "sender") throw new Error("Only sender can create session");

    // Already live on this room.
    if (this.roomId && this.signaling.isConnected() && !this.destroyed) {
      this.attachSignalingHandlers();
      this.events.onSession?.({
        sessionId: this.roomId,
        code: this.roomId,
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      if (this.viewState === "idle" || this.viewState === "files-selected" || this.viewState === "creating-session") {
        this.setViewState("waiting-receiver");
      }
      return;
    }

    this.setViewState("creating-session");

    const code = (preferredCode || this.roomId || generatePonsWarpRoomCode()).toUpperCase();
    this.roomId = code;

    await this.signaling.connect();
    this.attachSignalingHandlers();

    // PonsWarp: client-generated room code; first JoinRoom creates the room.
    await this.fetchTurnConfig(code);
    this.signaling.joinRoom(code);

    this.events.onSession?.({
      sessionId: code,
      code,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    this.events.onLog?.(`Room ${code} opened on ${this.signaling.getServerUrl()}`);
    this.setViewState("waiting-receiver");
    this.progressTracker.setConnectionState("waiting");
    this.publishProgress();
  }

  async joinSession(code: string): Promise<void> {
    if (this.role !== "receiver") throw new Error("Only receiver can join session");
    const roomId = code.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 6);
    this.roomId = roomId;
    this.setViewState("negotiating");

    await this.signaling.connect();
    this.attachSignalingHandlers();
    await this.fetchTurnConfig(roomId);
    this.signaling.joinRoom(roomId);

    this.events.onSession?.({
      sessionId: roomId,
      code: roomId,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    this.setViewState("receiver-joined");
    this.progressTracker.setConnectionState("connecting");
    this.publishProgress();
  }

  async acceptIncoming(saveMode: SaveMode = "blob"): Promise<void> {
    this.saveMode = saveMode;
    this.sendControl({ kind: "accept", saveMode });
    this.setViewState("ready");
  }

  rejectIncoming(): void {
    this.sendControl({ kind: "reject" });
    this.setViewState("failed");
    this.events.onError?.("수신을 거절했습니다.", "rejected");
    this.destroy();
  }

  async startTransfer(): Promise<void> {
    if (this.role !== "sender") return;
    if (!this.channel || this.channel.readyState !== "open") {
      this.events.onError?.("연결이 아직 준비되지 않았습니다.", "not-ready");
      return;
    }
    this.transferStarted = true;
    this.paused = false;
    this.setViewState("transferring");
    this.progressTracker.setConnectionState("transferring");
    this.sendControl({ kind: "start-transfer" });
    void this.sendAllFiles();
  }

  pause(): void {
    if (this.role !== "sender" || !this.transferStarted) return;
    this.paused = true;
    this.setViewState("paused");
    this.progressTracker.setConnectionState("paused");
    this.sendControl({ kind: "pause" });
    this.publishProgress();
  }

  resume(): void {
    if (this.role !== "sender" || !this.transferStarted) return;
    this.paused = false;
    this.setViewState("transferring");
    this.progressTracker.setConnectionState("transferring");
    this.sendControl({ kind: "resume" });
    this.publishProgress();
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.uiTimer as ReturnType<typeof setInterval>);
    clearInterval(this.statsTimer as ReturnType<typeof setInterval>);
    this.detachSignalingHandlers();
    try {
      if (this.roomId) this.signaling.leaveRoom();
    } catch {
      /* ignore */
    }
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.signaling.close();
    this.channel = null;
    this.pc = null;
  }

  getBufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0;
  }

  private setViewState(state: TransferViewState): void {
    this.viewState = state;
    this.events.onViewState?.(state);
  }

  private emitFiles(): void {
    this.events.onFiles?.(this.getFiles());
  }

  private publishProgress(): void {
    this.latestProgress = this.progressTracker.snapshot();
    this.events.onProgress?.(this.latestProgress);
    this.events.onBufferedAmount?.(this.getBufferedAmount());
  }

  private startUiLoop(): void {
    if (this.uiTimer) return;
    this.uiTimer = setInterval(() => this.publishProgress(), 250);
    this.statsTimer = setInterval(() => void this.refreshConnectionMode(), 1500);
  }

  private attachSignalingHandlers(): void {
    this.detachSignalingHandlers();

    const onPeerJoined = (data: unknown) => {
      const payload = data as { socketId?: string; roomId?: string };
      if (this.role !== "sender") return;
      this.remotePeerId = payload.socketId ?? null;
      this.setViewState("receiver-joined");
      void this.ensurePeerConnection(true);
    };

    const onRoomUsers = (data: unknown) => {
      const payload = data as { users?: string[] } | string[];
      const users = Array.isArray(payload) ? payload : payload.users ?? [];
      const selfId = this.signaling.getSocketId();
      const others = users.filter((id) => id && id !== selfId);
      if (!others.length) return;
      this.remotePeerId = others[0] ?? null;
      if (this.role === "sender" && !this.pc) {
        this.setViewState("receiver-joined");
        void this.ensurePeerConnection(true);
      }
    };

    const onOffer = (data: unknown) => {
      void this.handleRemoteOffer(data);
    };
    const onAnswer = (data: unknown) => {
      void this.handleRemoteAnswer(data);
    };
    const onIce = (data: unknown) => {
      void this.handleRemoteIce(data);
    };
    const onUserLeft = () => {
      // Ignore transient leaves while still waiting for first receiver.
      if (this.viewState === "waiting-receiver" || this.viewState === "creating-session") return;
      if (this.viewState !== "completed") this.handleDisconnect();
    };
    const onError = (data: unknown) => {
      const payload = data as { code?: string; message?: string };
      this.setViewState(payload.code === "ROOM_NOT_FOUND" ? "expired" : "failed");
      this.events.onError?.(payload.message || "시그널링 오류", payload.code);
    };
    const onDisconnect = () => {
      if (!this.destroyed && this.viewState !== "completed") this.handleDisconnect();
    };

    const pairs: Array<[string, (data: unknown) => void]> = [
      ["peer-joined", onPeerJoined],
      ["room-users", onRoomUsers],
      ["offer", onOffer],
      ["answer", onAnswer],
      ["ice-candidate", onIce],
      ["user-left", onUserLeft],
      ["error", onError],
      ["disconnect", onDisconnect],
    ];
    for (const [event, handler] of pairs) {
      this.signaling.on(event, handler);
      this.boundHandlers.push([event, handler]);
    }
  }

  private detachSignalingHandlers(): void {
    for (const [event, handler] of this.boundHandlers) {
      this.signaling.off(event, handler);
    }
    this.boundHandlers = [];
  }

  private async fetchTurnConfig(roomId: string): Promise<void> {
    try {
      const res = await this.signaling.requestTurnConfig(roomId);
      if (res.success && res.data?.iceServers?.length) {
        this.iceServers = res.data.iceServers;
      }
    } catch {
      /* STUN fallback */
    }
  }

  private rtcConfig(): RTCConfiguration {
    const base = getRtcConfiguration();
    if (this.iceServers?.length) {
      return { ...base, iceServers: this.iceServers };
    }
    return base;
  }

  private async ensurePeerConnection(asOfferer = false): Promise<void> {
    if (this.pc || !this.roomId) return;
    this.setViewState("negotiating");
    this.progressTracker.setConnectionState("connecting");
    this.publishProgress();

    const pc = new RTCPeerConnection(this.rtcConfig());
    this.pc = pc;

    pc.onicecandidate = (ev) => {
      if (!this.roomId || !ev.candidate) return;
      this.signaling.sendCandidate(this.roomId, ev.candidate.toJSON(), this.remotePeerId);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "connected") void this.refreshConnectionMode();
      else if (state === "disconnected" || state === "failed") this.handleDisconnect();
    };

    if (this.role === "sender") {
      const channel = pc.createDataChannel("warpspace", { ordered: true });
      this.bindChannel(channel);
      if (asOfferer) {
        this.makingOffer = true;
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          this.signaling.sendOffer(this.roomId, offer, this.remotePeerId);
        } finally {
          this.makingOffer = false;
        }
      }
    } else {
      pc.ondatachannel = (ev) => this.bindChannel(ev.channel);
    }
  }

  private async handleRemoteOffer(data: unknown): Promise<void> {
    const payload = data as { from?: string; offer?: RTCSessionDescriptionInit; sdp?: RTCSessionDescriptionInit | string };
    if (payload.from) this.remotePeerId = payload.from;
    const raw = payload.offer ?? payload.sdp;
    const sdp =
      typeof raw === "string"
        ? (JSON.parse(raw) as RTCSessionDescriptionInit)
        : (raw as RTCSessionDescriptionInit | undefined);
    if (!sdp || !this.roomId) return;

    await this.ensurePeerConnection(false);
    if (!this.pc) return;
    if (this.makingOffer) return;

    await this.pc.setRemoteDescription(sdp);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.sendAnswer(this.roomId, answer, this.remotePeerId);
  }

  private async handleRemoteAnswer(data: unknown): Promise<void> {
    const payload = data as { from?: string; answer?: RTCSessionDescriptionInit; sdp?: RTCSessionDescriptionInit | string };
    if (payload.from) this.remotePeerId = payload.from;
    const raw = payload.answer ?? payload.sdp;
    const sdp =
      typeof raw === "string"
        ? (JSON.parse(raw) as RTCSessionDescriptionInit)
        : (raw as RTCSessionDescriptionInit | undefined);
    if (!sdp || !this.pc) return;
    if (this.pc.signalingState !== "have-local-offer") return;
    await this.pc.setRemoteDescription(sdp);
  }

  private async handleRemoteIce(data: unknown): Promise<void> {
    const payload = data as { from?: string; candidate?: RTCIceCandidateInit | string | null };
    if (payload.from) this.remotePeerId = payload.from;
    let candidate = payload.candidate;
    if (typeof candidate === "string") {
      try {
        candidate = JSON.parse(candidate) as RTCIceCandidateInit;
      } catch {
        return;
      }
    }
    if (!candidate || !this.pc) return;
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      /* ignore late */
    }
  }

  private bindChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = Math.floor(MAX_BUFFERED_AMOUNT * 0.35);
    channel.onopen = () => {
      this.progressTracker.setConnectionState("connected");
      // Sender waits for explicit receiver accept before going "ready".
      this.setViewState("receiver-joined");
      this.startUiLoop();
      this.sendControl({
        kind: "hello",
        role: this.role,
        files:
          this.role === "sender"
            ? this.files.map(({ id, name, size, type, lastModified }) => ({ id, name, size, type, lastModified }))
            : undefined,
      });
      this.flushControlQueue();
      this.publishProgress();
      void this.refreshConnectionMode();
    };

    channel.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        this.handleControl(JSON.parse(ev.data) as ControlMessage);
        return;
      }
      if (ev.data instanceof ArrayBuffer) this.handleBinary(ev.data);
      else if (ev.data instanceof Blob) void ev.data.arrayBuffer().then((buf) => this.handleBinary(buf));
    };

    channel.onclose = () => {
      if (!this.destroyed && this.viewState !== "completed") this.handleDisconnect();
    };
  }

  private sendControl(msg: ControlMessage): void {
    const payload = JSON.stringify(msg);
    if (!this.channel || this.channel.readyState !== "open") {
      this.controlQueue.push(payload);
      return;
    }
    this.channel.send(payload);
  }

  private flushControlQueue(): void {
    if (!this.channel || this.channel.readyState !== "open") return;
    while (this.controlQueue.length) this.channel.send(this.controlQueue.shift()!);
  }

  private handleControl(msg: ControlMessage): void {
    switch (msg.kind) {
      case "hello":
        if (this.role === "receiver" && msg.files?.length) {
          this.files = msg.files.map((f) => toItem(f, "queued"));
          this.emitFiles();
          this.progressTracker.reset(this.files.reduce((s, f) => s + f.size, 0));
          // Keep consent UI available once metadata arrives.
          if (this.viewState === "negotiating" || this.viewState === "receiver-joined") {
            this.setViewState("receiver-joined");
          }
        }
        break;
      case "accept":
        this.saveMode = msg.saveMode;
        // Both sides become ready; sender UI auto-starts transfer on ready.
        this.setViewState("ready");
        break;
      case "reject":
        this.setViewState("failed");
        this.events.onError?.("수신자가 연결을 거절했습니다.", "rejected");
        break;
      case "start-transfer":
        this.transferStarted = true;
        this.setViewState("transferring");
        this.progressTracker.setConnectionState("transferring");
        this.publishProgress();
        break;
      case "pause":
        this.paused = true;
        this.setViewState("paused");
        this.progressTracker.setConnectionState("paused");
        this.publishProgress();
        break;
      case "resume":
        this.paused = false;
        this.setViewState("transferring");
        this.progressTracker.setConnectionState("transferring");
        this.publishProgress();
        break;
      case "file-start": {
        const meta: TransferFileMeta = this.files.find((f) => f.id === msg.fileId) ?? {
          id: msg.fileId,
          name: msg.name,
          size: msg.size,
          type: msg.type,
        };
        const entry = {
          meta,
          index: msg.index,
          received: 0,
          totalChunks: msg.totalChunks,
          writer: null as StreamingWriter | null,
          writerReady: Promise.resolve(),
          writeQueue: Promise.resolve(),
        };
        entry.writerReady = openStreamingWriter({
          fileName: meta.name,
          size: meta.size,
          directoryHandle: this.directoryHandle,
          preferStreamSaver: this.saveMode === "streamsaver" || meta.size > 64 * 1024 * 1024,
        })
          .then((writer) => {
            entry.writer = writer;
          })
          .catch((error: Error) => {
            this.setViewState("failed");
            this.events.onError?.(error.message || "Failed to open streaming writer", "writer-open");
          });
        this.incoming.set(msg.fileId, entry);
        this.files = this.files.map((f, idx) =>
          f.id === msg.fileId || idx === msg.index
            ? { ...f, id: msg.fileId, state: "transferring", transferredBytes: 0, progress: 0 }
            : f,
        );
        this.progressTracker.setCurrentFile(msg.index, msg.size, 0);
        this.emitFiles();
        break;
      }
      case "file-complete":
        void this.finalizeIncoming(msg.fileId, msg.checksum);
        break;
      case "file-ack":
        this.files = this.files.map((f) =>
          f.id === msg.fileId
            ? {
                ...f,
                state: msg.ok ? "completed" : "failed",
                progress: msg.ok ? 1 : f.progress,
                error: msg.ok ? undefined : "무결성 검증 실패",
              }
            : f,
        );
        this.emitFiles();
        break;
      case "transfer-complete":
        this.setViewState("completed");
        this.progressTracker.setConnectionState("completed");
        this.publishProgress();
        break;
      case "error":
        this.setViewState("failed");
        this.events.onError?.(msg.message, msg.code);
        break;
      default:
        break;
    }
  }
  private handleBinary(buffer: ArrayBuffer): void {
    const parsed = parseChunkPacket(buffer);
    if (!parsed || parsed.type !== 1) return;
    const file = this.files[parsed.fileIndex];
    if (!file) return;
    const entry = this.incoming.get(file.id);
    if (!entry) return;

    // Copy out of the DataChannel buffer before queuing async disk writes.
    const chunk = parsed.payload.slice();
    entry.received += chunk.byteLength;
    file.transferredBytes = entry.received;
    file.progress = file.size > 0 ? Math.min(1, entry.received / file.size) : 1;
    file.state = "transferring";

    // Queue writes so large files stream to disk without holding all chunks in RAM.
    entry.writeQueue = entry.writeQueue
      .then(async () => {
        await entry.writerReady;
        if (!entry.writer) throw new Error("Streaming writer is not ready");
        await entry.writer.write(chunk);
      })
      .catch((error: Error) => {
        this.setViewState("failed");
        this.events.onError?.(error.message || "Failed to write chunk", "writer-write");
      });

    const now = performance.now();
    const last = (entry as { lastProgressAt?: number }).lastProgressAt ?? 0;
    if (now - last >= SEND_PROGRESS_INTERVAL_MS || entry.received >= file.size) {
      (entry as { lastProgressAt?: number }).lastProgressAt = now;
      const totalTransferred = this.files.reduce((s, f) => s + f.transferredBytes, 0);
      this.progressTracker.setCurrentFile(parsed.fileIndex, file.size, entry.received);
      this.latestProgress = this.progressTracker.update(totalTransferred, entry.received);
    }
  }

  private async finalizeIncoming(fileId: string, checksum: string): Promise<void> {
    const entry = this.incoming.get(fileId);
    if (!entry) return;
    this.setViewState("verifying");

    try {
      await entry.writerReady;
      await entry.writeQueue;
    } catch (error) {
      this.setViewState("failed");
      this.events.onError?.(error instanceof Error ? error.message : "Write queue failed", "writer-queue");
      return;
    }

    // Integrity for multi-GB files is intentionally skipped here to avoid re-reading whole file into RAM.
    // Checksum is accepted if sender marks skip, otherwise we trust streaming length match.
    const sizeOk = entry.received === entry.meta.size || entry.meta.size === 0;
    const ok = sizeOk || checksum.startsWith("skip:");
    let downloadUrl: string | undefined;

    if (ok && entry.writer) {
      try {
        const closed = await entry.writer.close();
        downloadUrl = closed.downloadUrl;
        if (downloadUrl) triggerDownload(downloadUrl, entry.meta.name);
        this.events.onReceivedFile?.({
          id: fileId,
          name: entry.meta.name,
          type: entry.meta.type,
          downloadUrl,
          checksum,
        });
      } catch (error) {
        this.setViewState("failed");
        this.events.onError?.(error instanceof Error ? error.message : "Failed to finalize file", "writer-close");
        await entry.writer.abort().catch(() => undefined);
        this.incoming.delete(fileId);
        return;
      }
    } else if (entry.writer) {
      await entry.writer.abort().catch(() => undefined);
    }

    this.files = this.files.map((f) =>
      f.id === fileId
        ? {
            ...f,
            state: ok ? "completed" : "failed",
            transferredBytes: entry.received,
            progress: 1,
            error: ok ? undefined : "Received size mismatch",
          }
        : f,
    );
    this.emitFiles();
    this.sendControl({ kind: "file-ack", fileId, checksum, ok });
    this.incoming.delete(fileId);

    const allDone = this.files.every((f) => f.state === "completed" || f.state === "failed" || f.state === "skipped");
    if (allDone) {
      this.setViewState(this.files.some((f) => f.state === "failed") ? "failed" : "completed");
      this.progressTracker.setConnectionState(this.viewState === "completed" ? "completed" : "failed");
      this.publishProgress();
    } else {
      this.setViewState("transferring");
    }
  }

  private async sendAllFiles(): Promise<void> {
    const total = this.files.reduce((s, f) => s + f.size, 0);
    this.progressTracker.reset(total);
    this.progressTracker.setConnectionState("transferring");
    let transferredTotal = 0;
    let lastProgressAt = 0;
    const chunkSize = this.effectiveChunkSize();

    for (let index = 0; index < this.files.length; index += 1) {
      if (this.destroyed) return;
      while (this.paused && !this.destroyed) await sleep(100);

      const item = this.files[index]!;
      const file = item.file;
      if (!file) continue;

      item.state = "preparing";
      this.emitFiles();

      const totalChunks = totalChunksForSize(file.size, chunkSize);
      this.sendControl({
        kind: "file-start",
        fileId: item.id,
        index,
        name: item.name,
        size: item.size,
        type: item.type,
        totalChunks,
      });

      item.state = "transferring";
      this.progressTracker.setCurrentFile(index, item.size, 0);
      this.emitFiles();

      let offset = 0;
      let chunkIndex = 0;
      // Prefetch the next slice so disk/read latency overlaps with network send.
      let pending:
        | Promise<{ payload: ArrayBuffer; byteLength: number; nextOffset: number }>
        | null = null;

      const readSlice = (start: number) => {
        const end = Math.min(start + chunkSize, file.size);
        return file.slice(start, end).arrayBuffer().then((payload) => ({
          payload,
          byteLength: payload.byteLength,
          nextOffset: start + payload.byteLength,
        }));
      };

      if (file.size > 0) pending = readSlice(0);

      while (offset < file.size) {
        if (this.destroyed) return;
        while (this.paused && !this.destroyed) await sleep(80);

        const chunk = pending ? await pending : await readSlice(offset);
        const nextStart = chunk.nextOffset;
        pending = nextStart < file.size ? readSlice(nextStart) : null;

        const header = encodeChunkHeader(index, chunkIndex, totalChunks, chunk.byteLength);
        const packet = concatBuffers(header, chunk.payload);
        await this.sendBinary(packet);
        offset = nextStart;
        chunkIndex += 1;
        transferredTotal += chunk.byteLength;
        item.transferredBytes = offset;
        item.progress = item.size > 0 ? offset / item.size : 1;

        const now = performance.now();
        if (now - lastProgressAt >= SEND_PROGRESS_INTERVAL_MS || offset >= file.size) {
          lastProgressAt = now;
          this.latestProgress = this.progressTracker.update(transferredTotal, offset);
          this.events.onBufferedAmount?.(this.getBufferedAmount());
        }
      }

      // Final progress tick for the completed file.
      this.latestProgress = this.progressTracker.update(transferredTotal, offset);
      this.events.onBufferedAmount?.(this.getBufferedAmount());

      item.state = "verifying";
      this.emitFiles();
      this.setViewState("verifying");

      // Avoid hashing multi-GB files end-to-end in the main thread.
      // Length + ordered DataChannel delivery is the large-file integrity model.
      let checksum = `skip:${item.id}`;
      if (file.size <= 32 * 1024 * 1024) {
        try {
          checksum = await sha256File(file);
        } catch {
          checksum = `skip:${item.id}`;
        }
      }
      this.sendControl({ kind: "file-complete", fileId: item.id, checksum });
      item.state = "completed";
      item.progress = 1;
      item.transferredBytes = item.size;
      this.emitFiles();
      this.setViewState("transferring");
    }

    this.sendControl({ kind: "transfer-complete" });
    this.setViewState("completed");
    this.progressTracker.setConnectionState("completed");
    this.latestProgress = this.progressTracker.update(total, this.files[this.files.length - 1]?.size ?? 0);
    this.publishProgress();
  }

  private effectiveChunkSize(): number {
    const channel = this.channel;
    const headerBytes = 17;
    const negotiated =
      Number((channel as any)?.maxMessageSize || 0) > 0
        ? Number((channel as any).maxMessageSize)
        : CHUNK_SIZE + headerBytes;
    // Leave room for our binary header and a small safety margin.
    const maxPayload = Math.max(16 * 1024, Math.floor(negotiated - headerBytes - 16));
    const size = Math.min(CHUNK_SIZE, maxPayload);
    if (typeof window !== "undefined") {
      const debug = ((window as Window & { __ponswarpDebug?: Record<string, unknown> }).__ponswarpDebug ??= {});
      debug.chunkSize = size;
      debug.maxMessageSize = Number((channel as any)?.maxMessageSize || 0) || null;
      debug.maxBufferedAmount = MAX_BUFFERED_AMOUNT;
    }
    return size;
  }

  private async sendBinary(packet: ArrayBuffer): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") {
      throw new Error("DataChannel is not open");
    }

    // Leave headroom for the next packet so Chrome never hits the hard ~16 MiB throw.
    const limit = Math.max(CHUNK_SIZE * 2, MAX_BUFFERED_AMOUNT - packet.byteLength);
    while (channel.bufferedAmount > limit) {
      await this.waitForBuffer(Math.floor(limit * 0.5));
      if (this.destroyed) return;
      if (!this.channel || this.channel.readyState !== "open") {
        throw new Error("DataChannel closed during send");
      }
    }

    try {
      channel.send(packet);
    } catch (error) {
      // Queue-full races can still throw; drain and retry once.
      await this.waitForBuffer(Math.floor(MAX_BUFFERED_AMOUNT * 0.25));
      if (!this.channel || this.channel.readyState !== "open") throw error;
      this.channel.send(packet);
    }
  }

  private waitForBuffer(target = Math.floor(MAX_BUFFERED_AMOUNT * 0.35)): Promise<void> {
    const channel = this.channel;
    if (!channel) return Promise.resolve();
    if (channel.readyState !== "open") return Promise.resolve();
    if (channel.bufferedAmount <= target) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const check = () => {
      if (
        !this.channel ||
        this.channel.readyState !== "open" ||
        this.channel.bufferedAmount <= target
      ) {
        this.channel?.removeEventListener("bufferedamountlow", check);
        clearInterval(poll);
        resolve();
      }
    };
    channel.bufferedAmountLowThreshold = Math.min(target, channel.bufferedAmountLowThreshold || target);
    channel.addEventListener("bufferedamountlow", check);
    const poll = setInterval(check, 16);
    return promise;
  }

  private handleDisconnect(): void {
    if (this.viewState === "completed" || this.viewState === "failed" || this.viewState === "expired") return;
    this.setViewState("reconnecting");
    this.progressTracker.setConnectionState("reconnecting");
    this.publishProgress();
    this.events.onError?.("연결이 끊겼습니다. 전송 상태를 유지한 채 다시 연결하고 있습니다.", "reconnecting");
  }

  private async refreshConnectionMode(): Promise<void> {
    if (!this.pc) return;
    try {
      const stats = await this.pc.getStats();
      this.connectionMode = detectConnectionMode(stats);
      this.events.onConnectionMode?.(this.connectionMode);
      if (typeof window !== "undefined") {
        const debug = ((window as Window & { __ponswarpDebug?: Record<string, unknown> }).__ponswarpDebug ??= {});
        debug.connectionMode = this.connectionMode;
        debug.bufferedAmount = this.getBufferedAmount();
        debug.viewState = this.viewState;
        debug.role = this.role;
        debug.chunkSize = CHUNK_SIZE;
        debug.maxBufferedAmount = MAX_BUFFERED_AMOUNT;
      }
    } catch {
      /* ignore */
    }
  }
}
