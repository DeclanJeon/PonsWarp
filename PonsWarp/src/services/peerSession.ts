/**
 * Native WebRTC PeerSession — control + bulk DataChannels.
 *
 * Replaces simple-peer for 1:1 transfer.
 * - control: ordered JSON control plane
 * - bulk-0: ordered reliable binary bulk plane
 */
import {
  LOW_WATER_MARK,
  DRAIN_EVENT_WATCHDOG_MS,
} from '../utils/constants';
import {
  TransferDiagnostics,
  CandidatePathKind,
  classifyHostAddressScope,
} from '../utils/transferFlowControl';
import { logInfo, logError } from '../utils/logger';

type EventHandler = (data: unknown) => void;

export type PeerSignalMessage =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit | null };

export interface PeerConfig {
  iceServers: RTCIceServer[];
  channelConfig?: RTCDataChannelInit;
  bulkChannelCount?: number;
  /**
   * Prefer LAN host candidates first. Keep all ICE servers, but do not force
   * relay-only. Mobile same-Wi-Fi often fails host UDP due to AP isolation and
   * falls back to TURN — that path is ~public uplink speed, not LAN.
   */
  iceTransportPolicy?: RTCIceTransportPolicy;
  iceCandidatePoolSize?: number;
}

export interface PeerState {
  id: string;
  connected: boolean;
  bufferedAmount: number;
  ready: boolean;
}

type CandidateStats = {
  id?: string;
  candidateType?: string;
  protocol?: string;
  relayProtocol?: string;
  address?: string;
  ip?: string;
  networkType?: string;
};

type CandidatePairStats = {
  id?: string;
  type?: string;
  selected?: boolean;
  nominated?: boolean;
  state?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  currentRoundTripTime?: number;
  availableOutgoingBitrate?: number;
};

const CONTROL_LABEL = 'control';
const bulkLabel = (i: number) => (i <= 0 ? 'bulk-0' : `bulk-${i}`);

export class PeerSession {
  public readonly id: string;
  public connected = false;
  public ready = false;
  /** Native peer connection (named `pc` for SinglePeerConnection compatibility). */
  public pc: RTCPeerConnection | null = null;

  private destroyed = false;
  private drainEmitted = false;
  private drainPollInterval: ReturnType<typeof setInterval> | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};
  private control: RTCDataChannel | null = null;
  private bulkChannels: RTCDataChannel[] = [];
  private readonly bulkChannelCount: number;
  private lowWater: number;
  private makingOffer = false;
  private ignoreOffer = false;
  private readonly polite: boolean;
  private readonly initiator: boolean;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  constructor(peerId: string, initiator: boolean, config: PeerConfig) {
    this.id = peerId;
    this.initiator = initiator;
    // Non-initiator is polite (rolls back on glare).
    this.polite = !initiator;
    this.bulkChannelCount = Math.max(1, Math.min(4, config.bulkChannelCount ?? 1));
    this.lowWater = LOW_WATER_MARK;
    this.initialize(config);
  }

  public on<T = unknown>(event: string, handler: (data: T) => void): void {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(handler as EventHandler);
  }

  public off<T = unknown>(event: string, handler: (data: T) => void): void {
    if (!this.eventListeners[event]) return;
    this.eventListeners[event] = this.eventListeners[event].filter(
      h => h !== handler
    );
  }

  public removeAllListeners(): void {
    this.eventListeners = {};
  }

  private emit(event: string, data?: unknown): void {
    this.eventListeners[event]?.forEach(h => h(data));
  }

  private initialize(config: PeerConfig): void {
    try {
      this.pc = new RTCPeerConnection({
        iceServers: config.iceServers,
        // Prefer direct candidates when possible; still allow TURN fallback.
        iceTransportPolicy: config.iceTransportPolicy ?? 'all',
        iceCandidatePoolSize: config.iceCandidatePoolSize ?? 4,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      });
      this.wirePcEvents();

      if (this.initiator) {
        this.createLocalChannels(config);
        void this.createAndSendOffer();
      }

      logInfo(
        `[Peer ${this.id}]`,
        `Native PeerSession created (initiator: ${this.initiator}, bulk=${this.bulkChannelCount})`
      );
    } catch (error) {
      logError(`[Peer ${this.id}]`, 'Failed to create PeerSession:', error);
      throw error;
    }
  }

  private wirePcEvents(): void {
    if (!this.pc) return;

    this.pc.onicecandidate = event => {
      if (this.destroyed) return;
      this.emit('signal', {
        type: 'candidate',
        candidate: event.candidate ? event.candidate.toJSON() : null,
      } satisfies PeerSignalMessage);
    };

    this.pc.onconnectionstatechange = () => {
      if (!this.pc || this.destroyed) return;
      const state = this.pc.connectionState;
      if (state === 'failed' || state === 'closed') {
        this.connected = false;
        this.emit('close');
      } else if (state === 'disconnected') {
        // Transient; do not tear down immediately.
      }
    };

    this.pc.ondatachannel = event => {
      this.attachChannel(event.channel);
    };
  }

  private createLocalChannels(config: PeerConfig): void {
    if (!this.pc) return;
    const controlInit: RTCDataChannelInit = {
      ordered: true,
      ...(config.channelConfig ?? {}),
    };
    // Control must stay ordered/reliable even if bulk config overrides.
    controlInit.ordered = true;
    delete (controlInit as { maxRetransmits?: number }).maxRetransmits;
    delete (controlInit as { maxPacketLifeTime?: number }).maxPacketLifeTime;

    const control = this.pc.createDataChannel(CONTROL_LABEL, controlInit);
    this.attachChannel(control);

    for (let i = 0; i < this.bulkChannelCount; i++) {
      const bulkInit: RTCDataChannelInit = {
        ordered: true,
        ...(config.channelConfig ?? {}),
      };
      bulkInit.ordered = true;
      const bulk = this.pc.createDataChannel(bulkLabel(i), bulkInit);
      // Set water mark on the channel instance (not create init — DOM typings omit it)
      bulk.bufferedAmountLowThreshold = this.lowWater;
      this.attachChannel(bulk);
    }
  }

  private attachChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';

    if (channel.label === CONTROL_LABEL || channel.label === 'control') {
      this.control = channel;
      channel.onopen = () => this.maybeMarkConnected();
      channel.onclose = () => {
        if (!this.destroyed) {
          this.connected = false;
          this.emit('close');
        }
      };
      channel.onerror = () => {
        this.emit('error', new Error(`Control channel error on ${this.id}`));
      };
      channel.onmessage = event => {
        const data = event.data;
        if (typeof data === 'string') {
          this.emit('data', data);
          return;
        }
        if (data instanceof ArrayBuffer) {
          // Control should be text; still surface.
          this.emit('data', data);
          return;
        }
        if (ArrayBuffer.isView(data)) {
          this.emit(
            'data',
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          );
        }
      };
      return;
    }

    if (channel.label.startsWith('bulk')) {
      const idx = this.parseBulkIndex(channel.label);
      channel.bufferedAmountLowThreshold = this.lowWater;
      channel.onbufferedamountlow = () => this.emitDrainOnce();
      channel.onopen = () => {
        this.maybeMarkConnected();
        this.ensureDrainWatchdog();
      };
      channel.onclose = () => {
        if (!this.destroyed) {
          this.connected = false;
          this.emit('close');
        }
      };
      channel.onerror = () => {
        this.emit('error', new Error(`Bulk channel error on ${this.id}`));
      };
      channel.onmessage = event => {
        const data = event.data;
        if (data instanceof ArrayBuffer) {
          this.emit('data', data);
          return;
        }
        if (ArrayBuffer.isView(data)) {
          this.emit(
            'data',
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          );
          return;
        }
        if (data instanceof Blob) {
          data
            .arrayBuffer()
            .then(buf => this.emit('data', buf))
            .catch(err => this.emit('error', err));
          return;
        }
        if (typeof data === 'string') {
          // Misrouted control — still forward.
          this.emit('data', data);
        }
      };

      while (this.bulkChannels.length <= idx) {
        this.bulkChannels.push(null as unknown as RTCDataChannel);
      }
      this.bulkChannels[idx] = channel;
      this.bulkChannels = this.bulkChannels.filter(Boolean);
    }
  }

  private parseBulkIndex(label: string): number {
    const m = label.match(/^bulk-(\d+)$/);
    if (!m) return 0;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : 0;
  }

  private channelsReady(): boolean {
    const controlOpen = this.control?.readyState === 'open';
    const bulkOpen = this.bulkChannels.some(c => c?.readyState === 'open');
    return !!controlOpen && bulkOpen;
  }

  private maybeMarkConnected(): void {
    if (this.destroyed || this.connected) return;
    if (!this.channelsReady()) return;
    this.connected = true;
    this.drainEmitted = false;
    logInfo(`[Peer ${this.id}]`, 'Connected (control+bulk open)');
    this.emit('connected', this.id);
    this.ensureDrainWatchdog();
  }

  private ensureDrainWatchdog(): void {
    if (this.drainPollInterval) return;
    this.drainPollInterval = setInterval(() => {
      if (!this.connected || this.destroyed) return;
      const bulk = this.primaryBulk();
      if (!bulk || bulk.readyState !== 'open') return;
      if (bulk.bufferedAmount <= bulk.bufferedAmountLowThreshold) {
        this.emitDrainOnce();
      }
    }, DRAIN_EVENT_WATCHDOG_MS);
  }

  private emitDrainOnce(): void {
    if (!this.drainEmitted && this.connected) {
      this.drainEmitted = true;
      this.emit('drain', this.id);
      queueMicrotask(() => {
        this.drainEmitted = false;
      });
    }
  }

  private primaryBulk(): RTCDataChannel | null {
    return this.bulkChannels.find(c => c && c.readyState === 'open') ?? null;
  }

  /** Path-aware water mark: elevated-RTT host uses a higher low-water. */
  public setBufferedAmountLowThreshold(bytes: number): void {
    const next = Math.max(64 * 1024, Math.floor(bytes));
    this.lowWater = next;
    for (const ch of this.bulkChannels) {
      if (ch) ch.bufferedAmountLowThreshold = next;
    }
  }


  private async createAndSendOffer(): Promise<void> {
    if (!this.pc || this.destroyed) return;
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const sdp = this.pc.localDescription?.sdp;
      if (!sdp) return;
      this.emit('signal', { type: 'offer', sdp } satisfies PeerSignalMessage);
    } catch (error) {
      logError(`[Peer ${this.id}]`, 'createOffer failed:', error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.makingOffer = false;
    }
  }

  /**
   * Accept remote signaling (offer/answer/candidate).
   * Compatible with simple-peer-style payloads when possible.
   */
  public signal(data: unknown): void {
    if (this.destroyed || !this.pc) {
      logError(`[Peer ${this.id}]`, 'Cannot signal: peer destroyed');
      return;
    }
    void this.acceptSignal(data);
  }

  private async acceptSignal(raw: unknown): Promise<void> {
    if (!this.pc || this.destroyed) return;

    let msg = raw as Record<string, unknown>;
    if (typeof raw === 'string') {
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
    }
    if (!msg || typeof msg !== 'object') return;

    try {
      // simple-peer legacy shapes: { type: 'offer'|'answer', sdp } or { candidate }
      if (msg.type === 'offer' && typeof msg.sdp === 'string') {
        await this.onRemoteOffer(msg.sdp);
        return;
      }
      if (msg.type === 'answer' && typeof msg.sdp === 'string') {
        await this.onRemoteAnswer(msg.sdp);
        return;
      }
      if (msg.type === 'candidate' || 'candidate' in msg) {
        const candidate =
          msg.type === 'candidate'
            ? (msg.candidate as RTCIceCandidateInit | null)
            : (msg as RTCIceCandidateInit);
        await this.onRemoteCandidate(candidate);
        return;
      }
      // Nested simple-peer renegotiation packets sometimes wrap differently.
      if (typeof msg.sdp === 'string' && typeof msg.type === 'string') {
        if (msg.type === 'offer') await this.onRemoteOffer(msg.sdp);
        else if (msg.type === 'answer') await this.onRemoteAnswer(msg.sdp);
      }
    } catch (error) {
      logError(`[Peer ${this.id}]`, 'signal handling failed:', error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async onRemoteOffer(sdp: string): Promise<void> {
    if (!this.pc) return;
    const offerCollision =
      this.makingOffer || this.pc.signalingState !== 'stable';
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    this.remoteDescriptionSet = true;
    await this.flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    const localSdp = this.pc.localDescription?.sdp;
    if (localSdp) {
      this.emit('signal', {
        type: 'answer',
        sdp: localSdp,
      } satisfies PeerSignalMessage);
    }
  }

  private async onRemoteAnswer(sdp: string): Promise<void> {
    if (!this.pc) return;
    if (this.pc.signalingState === 'stable') return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    this.remoteDescriptionSet = true;
    await this.flushPendingCandidates();
  }

  private async onRemoteCandidate(
    candidate: RTCIceCandidateInit | null
  ): Promise<void> {
    if (!this.pc) return;
    if (!candidate) {
      try {
        await this.pc.addIceCandidate(null);
      } catch {
        // ignore end-of-candidates errors
      }
      return;
    }
    if (!this.remoteDescriptionSet && !this.pc.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (error) {
      if (!this.ignoreOffer) {
        logError(`[Peer ${this.id}]`, 'addIceCandidate failed:', error);
      }
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    if (!this.pc) return;
    const pending = this.pendingCandidates.splice(0);
    for (const c of pending) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        // ignore stale candidates
      }
    }
  }

  /**
   * Send control JSON string or bulk ArrayBuffer.
   * Strings always go to control; binary always to bulk.
   */
  public send(data: ArrayBuffer | string): boolean {
    if (!this.connected || this.destroyed) return false;

    if (typeof data === 'string') {
      const ch = this.control;
      if (!ch || ch.readyState !== 'open') return false;
      try {
        ch.send(data);
        return true;
      } catch {
        return false;
      }
    }

    const bulk = this.pickBulkForSend();
    if (!bulk || bulk.readyState !== 'open') return false;
    try {
      bulk.send(data);
      return true;
    } catch {
      return false;
    }
  }

  public sendControl(obj: object): boolean {
    return this.send(JSON.stringify(obj));
  }

  public sendBulk(packet: ArrayBuffer, channelIndex = 0): boolean {
    if (!this.connected || this.destroyed) return false;
    const bulk =
      this.bulkChannels[channelIndex] &&
      this.bulkChannels[channelIndex].readyState === 'open'
        ? this.bulkChannels[channelIndex]
        : this.pickBulkForSend();
    if (!bulk || bulk.readyState !== 'open') return false;
    try {
      bulk.send(packet);
      return true;
    } catch {
      return false;
    }
  }

  private pickBulkForSend(): RTCDataChannel | null {
    const open = this.bulkChannels.filter(c => c && c.readyState === 'open');
    if (open.length === 0) return null;
    if (open.length === 1) return open[0];
    let best = open[0];
    for (const ch of open) {
      if (ch.bufferedAmount < best.bufferedAmount) best = ch;
    }
    return best;
  }

  public getBufferedAmount(): number {
    if (this.destroyed) return 0;
    let highest = 0;
    for (const ch of this.bulkChannels) {
      if (ch && ch.readyState === 'open' && ch.bufferedAmount > highest) {
        highest = ch.bufferedAmount;
      }
    }
    return highest;
  }

  public getBulkChannelCount(): number {
    return this.bulkChannels.filter(c => c && c.readyState === 'open').length;
  }

  public async getTransferDiagnostics(): Promise<TransferDiagnostics> {
    try {
      if (!this.pc || typeof this.pc.getStats !== 'function') {
        return this.getConservativeTransferDiagnostics();
      }
      return this.getTransferDiagnosticsFromStats(await this.pc.getStats());
    } catch {
      return this.getConservativeTransferDiagnostics();
    }
  }

  public getTransferDiagnosticsFromStats(
    stats?: RTCStatsReport | null
  ): TransferDiagnostics {
    const fallback = this.getConservativeTransferDiagnostics();
    try {
      if (!stats || typeof stats.forEach !== 'function') return fallback;

      let selectedPair: CandidatePairStats | null = null;
      stats.forEach(value => {
        const pair = value as CandidatePairStats;
        if (pair.type !== 'candidate-pair') return;
        if (pair.selected === true) {
          selectedPair = pair;
          return;
        }
        if (
          !selectedPair &&
          pair.nominated === true &&
          pair.state === 'succeeded'
        ) {
          selectedPair = pair;
        }
      });
      if (!selectedPair) return fallback;

      const localCandidate = selectedPair.localCandidateId
        ? (stats.get(selectedPair.localCandidateId) as
            | CandidateStats
            | undefined)
        : undefined;
      const remoteCandidate = selectedPair.remoteCandidateId
        ? (stats.get(selectedPair.remoteCandidateId) as
            | CandidateStats
            | undefined)
        : undefined;
      const succeeded =
        selectedPair.selected === true ||
        (selectedPair.nominated === true && selectedPair.state === 'succeeded');
      const tuple = {
        selectedPairId: selectedPair.id ?? null,
        localCandidateId: selectedPair.localCandidateId ?? null,
        remoteCandidateId: selectedPair.remoteCandidateId ?? null,
        localCandidateType: localCandidate?.candidateType ?? null,
        remoteCandidateType: remoteCandidate?.candidateType ?? null,
        localProtocol: localCandidate?.protocol?.toLowerCase() ?? null,
        remoteProtocol: remoteCandidate?.protocol?.toLowerCase() ?? null,
        selectedOrNominatedSucceeded: succeeded,
        sampledAtMs: Date.now(),
      };

      const pathKind = this.normalizeCandidatePath(
        localCandidate?.candidateType,
        remoteCandidate?.candidateType
      );
      const localAddress =
        localCandidate?.address ?? localCandidate?.ip ?? null;
      const remoteAddress =
        remoteCandidate?.address ?? remoteCandidate?.ip ?? null;
      return {
        candidatePathKind: pathKind,
        protocol: localCandidate?.protocol ?? remoteCandidate?.protocol ?? null,
        relayProtocol:
          localCandidate?.relayProtocol ??
          remoteCandidate?.relayProtocol ??
          null,
        rttMs: this.secondsToMilliseconds(selectedPair.currentRoundTripTime),
        availableOutgoingBitrateBps: this.finiteNumberOrNull(
          selectedPair.availableOutgoingBitrate
        ),
        bufferedAmountBytes: this.getBufferedAmount(),
        candidateTuple: tuple,
        hostAddressScope:
          pathKind === 'host'
            ? classifyHostAddressScope(localAddress, remoteAddress)
            : null,
      };
    } catch {
      return fallback;
    }
  }

  private getConservativeTransferDiagnostics(): TransferDiagnostics {
    return {
      candidatePathKind: 'unknown',
      protocol: null,
      relayProtocol: null,
      rttMs: null,
      availableOutgoingBitrateBps: null,
      bufferedAmountBytes: this.getBufferedAmount(),
      candidateTuple: null,
      hostAddressScope: null,
    };
  }

  private normalizeCandidatePath(
    localType?: string,
    remoteType?: string
  ): CandidatePathKind {
    if (typeof localType !== 'string' || typeof remoteType !== 'string') {
      return 'unknown';
    }
    // Path is constrained by the worse candidate on the selected pair.
    if (localType === 'relay' || remoteType === 'relay') return 'relay';
    if (localType === 'srflx' || remoteType === 'srflx') return 'srflx';
    if (localType === 'host' && remoteType === 'host') return 'host';
    return 'unknown';
  }

  private secondsToMilliseconds(value: unknown): number | null {
    const seconds = this.finiteNumberOrNull(value);
    return seconds === null ? null : seconds * 1000;
  }

  private finiteNumberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  public getState(): PeerState {
    return {
      id: this.id,
      connected: this.connected,
      bufferedAmount: this.getBufferedAmount(),
      ready: this.ready,
    };
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.connected = false;
    this.ready = false;

    for (const ch of this.bulkChannels) {
      try {
        ch?.close();
      } catch {
        // ignore
      }
    }
    try {
      this.control?.close();
    } catch {
      // ignore
    }
    this.bulkChannels = [];
    this.control = null;

    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        // ignore
      }
      this.pc = null;
    }

    if (this.drainPollInterval) {
      clearInterval(this.drainPollInterval);
      this.drainPollInterval = null;
    }

    this.removeAllListeners();
    logInfo(`[Peer ${this.id}]`, 'Destroyed');
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }
}
