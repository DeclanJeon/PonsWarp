/**
 * SinglePeerConnection - 단일 피어와의 WebRTC 연결 캡슐화
 *
 * Sender와 Receiver 모두에서 사용할 수 있는 범용 WebRTC 연결 래퍼입니다.
 * SwarmManager와 webRTCService 모두에서 사용하여 아키텍처를 통일합니다.
 */
import SimplePeer from 'simple-peer/simplepeer.min.js';
import {
  BULK_CHANNEL_COUNT,
  BULK_CHANNEL_INIT,
  BULK_CHANNEL_LABEL,
  BULK_PLANE_VNEXT,
  SPEED_BUFFER_LOW,
  SPEED_BULK_CHANNELS,
  SPEED_BULK_CHANNEL_ID_BASE,
  SPEED_TRANSFER,
  bulkChannelLabel,
  isBulkChannelLabel,
  HIGH_WATER_MARK,
  LOW_WATER_MARK,
} from '../utils/constants';
import {
  TransferDiagnostics,
  CandidatePathKind,
} from '../utils/transferFlowControl';
import { logInfo, logError, logWarn } from '../utils/logger';

type EventHandler = (data: unknown) => void;
type SimplePeerWithChannel = SimplePeer.Instance & {
  _channel?: RTCDataChannel;
};
type SimplePeerWithNative = SimplePeerWithChannel & {
  _pc?: RTCPeerConnection;
};

export interface PeerConfig {
  iceServers: RTCIceServer[];
  channelConfig?: RTCDataChannelInit;
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

export class SinglePeerConnection {
  public readonly id: string;
  public connected: boolean = false;
  public ready: boolean = false;

  public pc: SimplePeer.Instance | null = null;
  private destroyed: boolean = false;
  private drainEmitted: boolean = false;
  private drainPollInterval: ReturnType<typeof setInterval> | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};
  private bulkChannels: RTCDataChannel[] = [];
  private bulkReady = false;
  private bulkRr = 0;
  private enableBulkPlane: boolean;
  private readonly isInitiator: boolean;

  constructor(peerId: string, initiator: boolean, config: PeerConfig) {
    this.id = peerId;
    // Speed-first plain path: do NOT open extra DataChannels after connect.
    // Post-connect createDataChannel triggers renegotiation that can stall simple-peer.
    this.enableBulkPlane = BULK_PLANE_VNEXT && !SPEED_TRANSFER;
    this.isInitiator = initiator;
    this.initializePeer(initiator, config);
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

  private emit(event: string, data?: unknown): void {
    this.eventListeners[event]?.forEach(h => h(data));
  }

  public removeAllListeners(): void {
    this.eventListeners = {};
  }

  private initializePeer(initiator: boolean, config: PeerConfig): void {
    try {
      const options: SimplePeer.Options = {
        initiator,
        trickle: true,
        config: { iceServers: config.iceServers },
        channelConfig: {
          // Speed path: unordered reliable (app QA better than ordered on this harness).
          ordered: SPEED_TRANSFER || this.enableBulkPlane ? false : true,
          bufferedAmountLowThreshold: SPEED_TRANSFER ? SPEED_BUFFER_LOW : LOW_WATER_MARK,
          ...config.channelConfig,
        },
      };
      this.pc = new SimplePeer(options);

      this.setupEventHandlers();
      logInfo(`[Peer ${this.id}]`, `Created (initiator: ${initiator})`);
    } catch (error) {
      logError(`[Peer ${this.id}]`, 'Failed to create SimplePeer:', error);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.pc) return;

    // binaryType 강제 설정
    const forceArrayBuffer = () => {
      const channel = (this.pc as SimplePeerWithChannel | null)?._channel;
      if (channel && channel.binaryType !== 'arraybuffer') {
        channel.binaryType = 'arraybuffer';
      }
    };

    this.pc.on('signal', (data: SimplePeer.SignalData) => {
      this.emit('signal', data);
    });

    this.pc.on('connect', () => {
      forceArrayBuffer();
      this.connected = true;
      this.drainEmitted = false;
      logInfo(`[Peer ${this.id}]`, 'Connected');
      this.emit('connected', this.id);
      this.setupChannelEvents();
      // Speed path: negotiated multi bulk DCs (no renegotiation).
      this.setupNegotiatedSpeedBulkChannels();
      if (this.enableBulkPlane && !SPEED_TRANSFER) {
        this.setupBulkPlane();
      }
    });

    this.pc.on('data', (data: unknown) => {
      if (data instanceof Blob) {
        data
          .arrayBuffer()
          .then(buffer => this.emit('data', buffer))
          .catch(error => this.emit('error', error));
        return;
      }

      if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        // Zero-copy when the view already owns the whole buffer.
        if (
          view.byteOffset === 0 &&
          view.byteLength === view.buffer.byteLength &&
          view.buffer instanceof ArrayBuffer
        ) {
          this.emit('data', view.buffer);
          return;
        }
        // Only copy when the view is a window into a larger shared buffer.
        if (view.buffer instanceof ArrayBuffer) {
          this.emit(
            'data',
            view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
          );
          return;
        }
        // SharedArrayBuffer / exotic: copy into a fresh ArrayBuffer.
        const copy = new Uint8Array(view.byteLength);
        copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        this.emit('data', copy.buffer);
        return;
      }

      this.emit('data', data);
    });

    this.pc.on('error', (error: Error) => {
      logError(`[Peer ${this.id}]`, 'Error:', error);
      this.emit('error', error);
    });

    this.pc.on('close', () => {
      logInfo(`[Peer ${this.id}]`, 'Closed');
      this.connected = false;
      this.emit('close');
    });
  }

  private setupChannelEvents(): void {
    const channel = (this.pc as SimplePeerWithChannel | null)?._channel;
    if (!channel) return;

    // Control channel keeps ordered semantics; bulk uses its own watermarks.
    channel.bufferedAmountLowThreshold = this.enableBulkPlane
      ? Math.min(LOW_WATER_MARK, 256 * 1024)
      : LOW_WATER_MARK;

    channel.onbufferedamountlow = () => {
      if (!this.enableBulkPlane || !this.bulkReady) {
        this.emitDrainOnce();
      }
    };

    if (this.drainPollInterval) clearInterval(this.drainPollInterval);
    this.drainPollInterval = setInterval(() => {
      if (!this.connected || this.destroyed) return;
      if (this.enableBulkPlane) {
        const open = this.bulkChannels.filter(ch => ch.readyState === 'open');
        if (open.length > 0) {
          const anyLow = open.some(
            ch => ch.bufferedAmount <= (ch.bufferedAmountLowThreshold || 0)
          );
          if (anyLow) this.emitDrainOnce();
          return;
        }
      }
      if (channel.readyState !== 'open') return;
      if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
        this.emitDrainOnce();
      }
    }, 100);
  }

  private getNativePeerConnection(): RTCPeerConnection | null {
    const native = (this.pc as SimplePeerWithNative | null)?._pc;
    return native ?? null;
  }

  
  /**
   * Speed path: open N reliable-unordered bulk DataChannels with negotiated:true.
   * Both peers create the same ids — no SDP renegotiation, no simple-peer demux.
   */
  private setupNegotiatedSpeedBulkChannels(): void {
    if (!SPEED_TRANSFER) return;
    const n = Math.max(0, Math.min(4, SPEED_BULK_CHANNELS || 0));
    if (n <= 0) return; // disabled by default after LAN regression
    const native = this.getNativePeerConnection();
    if (!native) return;

    // Mark bulk plane active for sendBulk/getBufferedAmount.
    this.enableBulkPlane = true;

    for (let i = 0; i < n; i++) {
      const label = bulkChannelLabel(i);
      const id = SPEED_BULK_CHANNEL_ID_BASE + i;
      try {
        // Skip if already present.
        if (this.bulkChannels.some(ch => ch.label === label && ch.readyState !== 'closed')) {
          continue;
        }
        const channel = native.createDataChannel(label, {
          negotiated: true,
          id,
          ordered: false,
        });
        this.attachBulkChannel(channel);
      } catch (error) {
        logWarn(
          `[Peer ${this.id}]`,
          `Negotiated bulk channel failed label=${label} id=${id}`,
          error
        );
      }
    }
  }

  private setupBulkPlane(): void {
    const native = this.getNativePeerConnection();
    if (!native) {
      logWarn(
        `[Peer ${this.id}]`,
        'Bulk plane requested but native RTCPeerConnection is unavailable'
      );
      return;
    }

    // Answerer accepts remote bulk channels; offerer creates them.
    const prev = native.ondatachannel;
    native.ondatachannel = event => {
      if (isBulkChannelLabel(event.channel?.label)) {
        this.attachBulkChannel(event.channel);
        return;
      }
      if (typeof prev === 'function') {
        try {
          prev.call(native, event);
        } catch {
          // ignore
        }
      }
    };

    try {
      if (this.isInitiator) {
        const n = Math.max(1, Math.min(4, BULK_CHANNEL_COUNT || 1));
        for (let i = 0; i < n; i++) {
          const channel = native.createDataChannel(
            bulkChannelLabel(i),
            BULK_CHANNEL_INIT
          );
          this.attachBulkChannel(channel);
        }
      }
    } catch (error) {
      logWarn(`[Peer ${this.id}]`, 'Failed to create bulk data channel', error);
    }
  }

  private attachBulkChannel(channel: RTCDataChannel): void {
    if (this.destroyed) {
      try {
        channel.close();
      } catch {
        // ignore
      }
      return;
    }

    if (this.bulkChannels.includes(channel)) return;
    this.bulkChannels.push(channel);
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = SPEED_TRANSFER ? SPEED_BUFFER_LOW : LOW_WATER_MARK;

    const markReady = () => {
      if (channel.readyState === 'open') {
        this.bulkReady = this.bulkChannels.some(ch => ch.readyState === 'open');
        logInfo(
          `[Peer ${this.id}]`,
          `Bulk channel open label=${channel.label} ordered=${String(channel.ordered)} open=${this.bulkChannels.filter(c => c.readyState === 'open').length}/${this.bulkChannels.length}`
        );
        if (this.bulkReady) {
          this.emit('bulk-ready', this.id);
          this.emitDrainOnce();
        }
      }
    };

    channel.onopen = markReady;
    markReady();

    channel.onbufferedamountlow = () => {
      this.emitDrainOnce();
    };

    channel.onmessage = event => {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        this.emit('data', data);
        return;
      }
      if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        if (
          view.byteOffset === 0 &&
          view.byteLength === view.buffer.byteLength &&
          view.buffer instanceof ArrayBuffer
        ) {
          this.emit('data', view.buffer);
          return;
        }
        if (view.buffer instanceof ArrayBuffer) {
          this.emit(
            'data',
            view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
          );
          return;
        }
        const copy = new Uint8Array(view.byteLength);
        copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        this.emit('data', copy.buffer);
        return;
      }
      if (data instanceof Blob) {
        data
          .arrayBuffer()
          .then(buffer => this.emit('data', buffer))
          .catch(error => this.emit('error', error));
      }
    };

    channel.onclose = () => {
      this.bulkChannels = this.bulkChannels.filter(ch => ch !== channel);
      this.bulkReady = this.bulkChannels.some(ch => ch.readyState === 'open');
      logInfo(`[Peer ${this.id}]`, `Bulk channel closed label=${channel.label}`);
    };

    channel.onerror = () => {
      logWarn(`[Peer ${this.id}]`, `Bulk channel error label=${channel.label}`);
    };
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

  /**
   * 시그널링 데이터 처리 (offer/answer/ice-candidate)
   */
  public signal(data: SimplePeer.SignalData): void {
    if (this.destroyed || !this.pc) {
      logError(`[Peer ${this.id}]`, 'Cannot signal: peer destroyed');
      return;
    }
    this.pc.signal(data);
  }

  /**
   * Control-plane send (ordered simple-peer default channel).
   * Prefer strings/JSON here. Binary bulk should use sendBulk().
   */
  public send(data: ArrayBuffer | string): boolean {
    if (!this.connected || this.destroyed || !this.pc) {
      return false;
    }

    const channel = (this.pc as SimplePeerWithChannel)._channel;
    if (!channel || channel.readyState !== 'open') {
      return false;
    }

    // If bulk plane is active and payload is binary, prefer bulk channel.
    if (
      this.enableBulkPlane &&
      this.bulkReady &&
      typeof data !== 'string' &&
      (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
    ) {
      return this.sendBulk(data as ArrayBuffer);
    }

    this.pc.send(data);
    return true;
  }

  /**
   * Bulk-plane send: reliable-unordered channel when available.
   * Falls back to control/default channel for legacy peers / flag-off.
   * Never returns false solely for backpressure — caller paces via getBufferedAmount().
   */
  private pickBulkChannel(): RTCDataChannel | null {
    const open = this.bulkChannels.filter(ch => ch.readyState === 'open');
    if (open.length === 0) return null;
    // Prefer lowest bufferedAmount; tiny RR bias for fairness.
    let best = open[0];
    let bestBuf = best.bufferedAmount || 0;
    for (let i = 1; i < open.length; i++) {
      const b = open[i].bufferedAmount || 0;
      if (b < bestBuf) {
        best = open[i];
        bestBuf = b;
      }
    }
    // If several are empty, rotate.
    if (bestBuf === 0 && open.length > 1) {
      this.bulkRr = (this.bulkRr + 1) % open.length;
      return open[this.bulkRr];
    }
    return best;
  }

  public sendBulk(data: ArrayBuffer | ArrayBufferView): boolean {
    const payload = data as BufferSource;
    if (!this.connected || this.destroyed) return false;

    if (this.enableBulkPlane) {
      const bulk = this.pickBulkChannel();
      if (bulk) {
        try {
          bulk.send(payload as ArrayBuffer);
          return true;
        } catch (error) {
          logWarn(`[Peer ${this.id}]`, 'bulk send failed', error);
          return false;
        }
      }
    }

    // Legacy / not-yet-ready bulk: single default channel.
    if (!this.pc) return false;
    const channel = (this.pc as SimplePeerWithChannel)._channel;
    if (!channel || channel.readyState !== 'open') return false;
    try {
      // Prefer native DC.send (raw-dc style). Accept views to avoid copy.
      channel.send(payload as ArrayBuffer);
      return true;
    } catch {
      try {
        // simple-peer expects ArrayBuffer-like
        const ab =
          ArrayBuffer.isView(data)
            ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            : data;
        this.pc.send(ab as ArrayBuffer);
        return true;
      } catch {
        return false;
      }
    }
  }

  public hasBulkChannel(): boolean {
    return this.bulkChannels.some(ch => ch.readyState === 'open');
  }

  public getOpenBulkChannelCount(): number {
    return this.bulkChannels.filter(ch => ch.readyState === 'open').length;
  }

  public getOpenBulkChannels(): RTCDataChannel[] {
    return this.bulkChannels.filter(ch => ch.readyState === 'open');
  }

  public isBulkPlaneEnabled(): boolean {
    return this.enableBulkPlane;
  }

  /**
   * Wait until dedicated bulk channel is open, or timeout and continue with fallback.
   */
  public async waitForBulkReady(timeoutMs = 1500): Promise<boolean> {
    if (!this.enableBulkPlane) return false;
    if (this.hasBulkChannel()) return true;
    if (!this.connected || this.destroyed) return false;

    const { promise, resolve } = Promise.withResolvers<boolean>();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      this.off('bulk-ready', onReady);
      clearTimeout(timer);
      resolve(ok);
    };
    const onReady = () => done(true);
    this.on('bulk-ready', onReady);
    const timer = setTimeout(() => done(this.hasBulkChannel()), timeoutMs);
    // Race: may have opened between check and listener attach.
    if (this.hasBulkChannel()) done(true);
    return await promise;
  }

  /**
   * 현재 버퍼 크기 조회
   */
  public getChannelDebugInfo() {
    const channel = this.pc
      ? (this.pc as SimplePeerWithChannel)._channel
      : null;
    return {
      id: this.id,
      connected: this.connected,
      ordered: channel ? channel.ordered : null,
      reliable: channel ? (channel as RTCDataChannel).maxRetransmits === null || (channel as any).maxRetransmits === undefined : null,
      bufferedAmount: channel?.bufferedAmount ?? null,
      readyState: channel?.readyState ?? null,
      bulkOpen: this.bulkChannels.filter(c => c.readyState === 'open').length,
      enableBulkPlane: this.enableBulkPlane,
    };
  }

  public getBufferedAmount(): number {
    if (this.destroyed) return 0;
    if (this.enableBulkPlane) {
      const open = this.bulkChannels.filter(ch => ch.readyState === 'open');
      if (open.length > 0) {
        // Total queued across bulk streams (same SCTP assoc, multi-SID).
        return open.reduce((sum, ch) => sum + (ch.bufferedAmount || 0), 0);
      }
    }
    if (!this.pc) return 0;
    const channel = (this.pc as SimplePeerWithChannel)._channel;
    return channel?.bufferedAmount ?? 0;
  }

  public async getTransferDiagnostics(): Promise<TransferDiagnostics> {
    try {
      const nativePeer = (this.pc as SimplePeerWithNative | null)?._pc;
      if (!nativePeer || typeof nativePeer.getStats !== 'function') {
        return this.getConservativeTransferDiagnostics();
      }

      return this.getTransferDiagnosticsFromStats(await nativePeer.getStats());
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
            CandidateStats | undefined)
        : undefined;
      const remoteCandidate = selectedPair.remoteCandidateId
        ? (stats.get(selectedPair.remoteCandidateId) as
            CandidateStats | undefined)
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

      return {
        candidatePathKind: this.normalizeCandidatePath(
          localCandidate?.candidateType,
          remoteCandidate?.candidateType
        ),
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
    };
  }

  private normalizeCandidatePath(
    localType?: string,
    remoteType?: string
  ): CandidatePathKind {
    if (typeof localType !== 'string' || typeof remoteType !== 'string') {
      return 'unknown';
    }

    const types = [localType, remoteType];

    if (types.includes('relay')) return 'relay';
    if (types.includes('srflx')) return 'srflx';
    if (types.every(type => type === 'host')) return 'host';
    return 'unknown';
  }

  private secondsToMilliseconds(value: unknown): number | null {
    const seconds = this.finiteNumberOrNull(value);
    return seconds === null ? null : seconds * 1000;
  }

  private finiteNumberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /**
   * 피어 상태 조회
   */
  public getState(): PeerState {
    return {
      id: this.id,
      connected: this.connected,
      bufferedAmount: this.getBufferedAmount(),
      ready: this.ready,
    };
  }

  /**
   * 피어 연결 정리
   */
  public destroy(): void {
    if (this.destroyed) return;

    this.destroyed = true;
    this.connected = false;
    this.ready = false;
    this.bulkReady = false;

    for (const channel of this.bulkChannels) {
      try {
        channel.onopen = null;
        channel.onmessage = null;
        channel.onclose = null;
        channel.onerror = null;
        channel.onbufferedamountlow = null;
        channel.close();
      } catch {
        // ignore
      }
    }
    this.bulkChannels = [];

    if (this.pc) {
      this.pc.destroy();
      this.pc = null;
    }

    if (this.drainPollInterval) {
      clearInterval(this.drainPollInterval);
      this.drainPollInterval = null;
    }

    this.removeAllListeners();
    logInfo(`[Peer ${this.id}]`, 'Destroyed');
  }

  /**
   * 파괴 여부 확인
   */
  public isDestroyed(): boolean {
    return this.destroyed;
  }
}
