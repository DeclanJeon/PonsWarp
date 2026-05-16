/**
 * SinglePeerConnection - 단일 피어와의 WebRTC 연결 캡슐화
 *
 * Sender와 Receiver 모두에서 사용할 수 있는 범용 WebRTC 연결 래퍼입니다.
 * SwarmManager와 webRTCService 모두에서 사용하여 아키텍처를 통일합니다.
 */
import SimplePeer from 'simple-peer/simplepeer.min.js';
import { LOW_WATER_MARK } from '../utils/constants';
import { logInfo, logError } from '../utils/logger';

type EventHandler = (data: unknown) => void;
type SimplePeerWithChannel = SimplePeer.Instance & {
  _channel?: RTCDataChannel;
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

export class SinglePeerConnection {
  public readonly id: string;
  public connected: boolean = false;
  public ready: boolean = false;

  public pc: SimplePeer.Instance | null = null;
  private destroyed: boolean = false;
  private drainEmitted: boolean = false;
  private drainPollInterval: ReturnType<typeof setInterval> | null = null;
  private eventListeners: Record<string, EventHandler[]> = {};

  constructor(peerId: string, initiator: boolean, config: PeerConfig) {
    this.id = peerId;
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
          ordered: true,
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

    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;

    channel.onbufferedamountlow = () => {
      this.emitDrainOnce();
    };

    if (this.drainPollInterval) clearInterval(this.drainPollInterval);
    this.drainPollInterval = setInterval(() => {
      if (!this.connected || this.destroyed || channel.readyState !== 'open') return;
      if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
        this.emitDrainOnce();
      }
    }, 200);
  }

  private emitDrainOnce(): void {
    if (!this.drainEmitted && this.connected) {
      this.drainEmitted = true;
      this.emit('drain', this.id);
      // 다음 drain 이벤트를 위해 리셋
      setTimeout(() => {
        this.drainEmitted = false;
      }, 0);
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
   * 데이터 전송 (connected 상태일 때만)
   */
  public send(data: ArrayBuffer | string): boolean {
    if (!this.connected || this.destroyed || !this.pc) {
      return false;
    }

    const channel = (this.pc as SimplePeerWithChannel)._channel;
    if (!channel || channel.readyState !== 'open') {
      return false;
    }

    this.pc.send(data);
    return true;
  }

  /**
   * 현재 버퍼 크기 조회
   */
  public getBufferedAmount(): number {
    if (!this.pc || this.destroyed) return 0;
    const channel = (this.pc as SimplePeerWithChannel)._channel;
    return channel?.bufferedAmount ?? 0;
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
