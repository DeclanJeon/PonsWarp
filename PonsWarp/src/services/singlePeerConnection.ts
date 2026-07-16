/**
 * SinglePeerConnection - 단일 피어와의 WebRTC 연결 캡슐화
 *
 * Sender와 Receiver 모두에서 사용할 수 있는 범용 WebRTC 연결 래퍼입니다.
 * SwarmManager와 webRTCService 모두에서 사용하여 아키텍처를 통일합니다.
 */
import SimplePeer from 'simple-peer/simplepeer.min.js';
import {
  BULK_CHANNEL_INIT,
  BULK_CHANNEL_LABEL,
  BULK_PLANE_VNEXT,
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
  private bulkChannel: RTCDataChannel | null = null;
  private bulkReady = false;
  private readonly enableBulkPlane: boolean;
  private readonly isInitiator: boolean;

  constructor(peerId: string, initiator: boolean, config: PeerConfig) {
    this.id = peerId;
    this.enableBulkPlane = BULK_PLANE_VNEXT;
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
          // vNext: reliable-unordered default channel avoids SCTP HOL on bulk.
          // Control remains JSON/sparse; critical control is sent before bulk.
          ordered: this.enableBulkPlane ? false : true,
          bufferedAmountLowThreshold: LOW_WATER_MARK,
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
      if (this.enableBulkPlane) {
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
        const buffer = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength
        );
        this.emit('data', buffer);
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
      const bulk = this.bulkChannel;
      if (this.enableBulkPlane && bulk && bulk.readyState === 'open') {
        if (bulk.bufferedAmount <= bulk.bufferedAmountLowThreshold) {
          this.emitDrainOnce();
        }
        return;
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

  private setupBulkPlane(): void {
    const native = this.getNativePeerConnection();
    if (!native) {
      logWarn(
        `[Peer ${this.id}]`,
        'Bulk plane requested but native RTCPeerConnection is unavailable'
      );
      return;
    }

    // Answerer accepts remote bulk channel; offerer creates it.
    native.ondatachannel = event => {
      if (event.channel?.label === BULK_CHANNEL_LABEL) {
        this.attachBulkChannel(event.channel);
      }
    };

    // simple-peer initiator creates the default channel; same side opens bulk.
    try {
      if (this.isInitiator) {
        const channel = native.createDataChannel(
          BULK_CHANNEL_LABEL,
          BULK_CHANNEL_INIT
        );
        this.attachBulkChannel(channel);
      }
      // Non-initiator attaches via ondatachannel.
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

    this.bulkChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;

    const markReady = () => {
      if (channel.readyState === 'open') {
        this.bulkReady = true;
        logInfo(
          `[Peer ${this.id}]`,
          `Bulk channel open (ordered=${String(channel.ordered)})`
        );
        this.emit('bulk-ready', this.id);
        this.emitDrainOnce();
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
        const buffer = view.buffer.slice(
          view.byteOffset,
          view.byteOffset + view.byteLength
        );
        this.emit('data', buffer);
        return;
      }
      if (data instanceof Blob) {
        data
          .arrayBuffer()
          .then(buffer => this.emit('data', buffer))
          .catch(error => this.emit('error', error));
        return;
      }
      // Bulk plane is binary-only; ignore unexpected control strings.
    };

    channel.onclose = () => {
      this.bulkReady = false;
      if (this.bulkChannel === channel) this.bulkChannel = null;
      logInfo(`[Peer ${this.id}]`, 'Bulk channel closed');
    };

    channel.onerror = () => {
      logWarn(`[Peer ${this.id}]`, 'Bulk channel error');
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
  public sendBulk(data: ArrayBuffer): boolean {
    if (!this.connected || this.destroyed) return false;

    if (this.enableBulkPlane && this.bulkChannel?.readyState === 'open') {
      try {
        this.bulkChannel.send(data);
        return true;
      } catch (error) {
        logWarn(`[Peer ${this.id}]`, 'bulk send failed', error);
        return false;
      }
    }

    // Legacy / not-yet-ready bulk: single default channel.
    if (!this.pc) return false;
    const channel = (this.pc as SimplePeerWithChannel)._channel;
    if (!channel || channel.readyState !== 'open') return false;
    try {
      this.pc.send(data);
      return true;
    } catch {
      return false;
    }
  }

  public hasBulkChannel(): boolean {
    return Boolean(this.bulkChannel && this.bulkChannel.readyState === 'open');
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

    return await new Promise<boolean>(resolve => {
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
    });
  }

  /**
   * 현재 버퍼 크기 조회
   */
  public getBufferedAmount(): number {
    if (this.destroyed) return 0;
    if (this.enableBulkPlane && this.bulkChannel?.readyState === 'open') {
      return this.bulkChannel.bufferedAmount || 0;
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

    if (this.bulkChannel) {
      try {
        this.bulkChannel.onopen = null;
        this.bulkChannel.onmessage = null;
        this.bulkChannel.onclose = null;
        this.bulkChannel.onerror = null;
        this.bulkChannel.onbufferedamountlow = null;
        this.bulkChannel.close();
      } catch {
        // ignore
      }
      this.bulkChannel = null;
    }

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
