import { PeerConfig } from '../utils/config';
import { LOW_WATER_MARK, MULTI_CHANNEL_COUNT } from '../utils/constants';
import { logInfo, logError, logWarn } from '../utils/logger';
import { IPeerConnection, IPeerState } from './peerConnectionTypes';

// 이벤트 핸들러 타입
type EventHandler = (data: any) => void;

export interface PeerState extends IPeerState {
  // 추가 속성이 필요하면 여기에 정의
}

export class NativePeerConnection implements IPeerConnection {
  public readonly id: string;
  public connected: boolean = false;
  public ready: boolean = false;
  
  private pc: RTCPeerConnection | null = null;
  private dataChannels: RTCDataChannel[] = [];
  private eventListeners: Record<string, EventHandler[]> = {};
  private config: PeerConfig;
  
  // 라운드 로빈 로드 밸런싱을 위한 인덱스
  private nextChannelIndex = 0;
  
  // 🚀 ICE Restart 관련
  private isReconnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isDestroyed: boolean = false; // 🚀 [추가] 파괴 상태 추적

  constructor(config: PeerConfig) {
    this.config = config;
    this.id = config.id;
    this.initialize();
  }

  private initialize() {
    logInfo(`[NativePeer ${this.id}]`, 'Initializing...');

    this.pc = new RTCPeerConnection({
      iceServers: this.config.iceServers,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle', // 모든 트랙/채널을 단일 포트로 묶음 (연결 확률 증가)
      rtcpMuxPolicy: 'require'
    });

    // ICE Candidate 핸들링
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.emit('signal', { type: 'candidate', candidate: event.candidate });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      logInfo(`[NativePeer ${this.id}]`, `ICE State: ${state}`);
      
      if (state === 'connected' || state === 'completed') {
        if (!this.connected || this.isReconnecting) {
          this.connected = true;
          this.isReconnecting = false;
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          
          console.log(`[NativePeer ${this.id}] 🔗 [DEBUG] Connection established/restored, emitting 'connected' event`);
          this.emit('connected', this.id);
          
          if (!this.config.isInitiator) {
             if (this.dataChannels.length > 0 && this.dataChannels.every(ch => ch.readyState === 'open')) {
               this.ready = true;
             }
          }
        }
      }
      
      else if (state === 'disconnected') {
        logWarn(`[NativePeer ${this.id}]`, '⚠️ ICE Disconnected. Attempting restart...');
        this.handleDisconnect();
      }
      else if (state === 'failed') {
        logError(`[NativePeer ${this.id}]`, '❌ ICE Failed. Attempting one final restart...');
        this.handleDisconnect();
      }
      else if (state === 'closed') {
        this.connected = false;
        this.ready = false;
        this.emit('close', null);
      }
    };

    if (this.config.isInitiator) {
      this.createDataChannels();
      this.createOffer();
    } else {
      this.pc.ondatachannel = (event) => {
        this.setupChannel(event.channel);
        if (this.dataChannels.length === 1) {
            this.connected = true;
        }
      };
    }
  }

  private createDataChannels() {
    if (!this.pc) return;

    for (let i = 0; i < MULTI_CHANNEL_COUNT; i++) {
      const channel = this.pc.createDataChannel(`warp-channel-${i}`, {
        ordered: true,
      });
      this.setupChannel(channel);
    }
  }

  private setupChannel(channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
    channel.onopen = () => {
      logInfo(`[NativePeer ${this.id}]`, `Channel ${channel.label} OPEN`);
      console.log(`[NativePeer ${this.id}] 📡 [DEBUG] Channel opened:`, channel.label, 'Total channels:', this.dataChannels.length);
      
      if (this.dataChannels.every(ch => ch.readyState === 'open')) {
        this.ready = true;
        console.log(`[NativePeer ${this.id}] ✅ [DEBUG] All channels open, emitting 'connected' event`);
        if (!this.config.isInitiator) {
          this.emit('connected', this.id);
        }
      }
    };

    channel.onmessage = (event) => {
      console.log(`[NativePeer ${this.id}] 📨 [DEBUG] Message received on channel ${channel.label}:`, {
        dataType: typeof event.data,
        dataSize: event.data instanceof ArrayBuffer ? event.data.byteLength : event.data.length,
        preview: typeof event.data === 'string' ? event.data.substring(0, 50) : 'binary'
      });
      this.emit('data', event.data);
    };

    channel.onclose = () => {
      logWarn(`[NativePeer ${this.id}]`, `Channel ${channel.label} CLOSED`);
      this.dataChannels = this.dataChannels.filter(c => c !== channel);
      // 모든 채널이 닫혔을 때만 ready 상태를 false로 설정
      if (this.dataChannels.length === 0) {
        this.ready = false;
      }
    };

    channel.onerror = (error) => {
      logError(`[NativePeer ${this.id}]`, `Channel ${channel.label} ERROR`, error);
    };

    channel.onbufferedamountlow = () => {
      console.log(`[NativePeer ${this.id}] 💧 [DEBUG] bufferedamountlow event on channel ${channel.label}:`, {
        bufferedAmount: channel.bufferedAmount,
        threshold: channel.bufferedAmountLowThreshold,
        totalBuffered: this.getBufferedAmount()
      });
      this.emit('drain', this.id);
    };

    this.dataChannels.push(channel);
  }

  private async createOffer() {
    if (!this.pc) return;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.emit('signal', { type: 'offer', offer }); // 🚨 [수정] offer 객체 전체를 전달
    } catch (e) {
      this.emit('error', e);
    }
  }

  public async signal(data: any) {
    if (this.isDestroyed || !this.pc) return;

    try {
      if (data.type === 'offer' || data.type === 'answer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data));
        
        if (data.type === 'offer') {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.emit('signal', { type: 'answer', answer });
        }
      } else if (data.candidate) {
        if (this.pc.remoteDescription) {
            await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
            console.log(`[NativePeer ${this.id}] ⏳ Queueing candidate (remote description not set)`);
        }
      }
    } catch (e) {
      logError(`[NativePeer ${this.id}]`, 'Signaling error', e);
    }
  }

  public send(data: ArrayBuffer | ArrayBufferView | string): boolean {
    if (this.dataChannels.length === 0) return false;
    // 1. 단순 Round Robin 방식 (가장 빠름)
    /*
    const channel = this.dataChannels[this.nextChannelIndex % this.dataChannels.length];
    this.nextChannelIndex++;
    if (channel.readyState === 'open') {
        channel.send(data as any);
        return true;
    }
    */

    // 2. Load Balancing 방식 (버퍼가 적은 채널 우선) -> 더 안정적
    let bestChannel: RTCDataChannel | null = null;
    let minBuffer = Infinity;

    for (const channel of this.dataChannels) {
      if (channel.readyState === 'open') {
        if (channel.bufferedAmount < minBuffer) {
          minBuffer = channel.bufferedAmount;
          bestChannel = channel;
        }
      }
    }

    if (bestChannel) {
      if (typeof data === 'string') {
        bestChannel.send(data);
      } else {
        bestChannel.send(data as any);
      }
      return true;
    }

    return false; // 전송 가능한 채널 없음
  }

  /**
   * 전체 채널의 버퍼 총량 반환 (Backpressure 판단용)
   */
  public getBufferedAmount(): number {
    return this.dataChannels.reduce((acc, ch) => acc + ch.bufferedAmount, 0);
  }

  /**
   * 피어 상태 조회
   */
  public getState(): PeerState {
    return {
      id: this.id,
      connected: this.connected,
      bufferedAmount: this.getBufferedAmount(),
      ready: this.ready
    };
  }

  // === Event Emitter ===

  public on(event: string, handler: EventHandler) {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(handler);
  }

  public off(event: string, handler: EventHandler) {
    if (!this.eventListeners[event]) return;
    this.eventListeners[event] = this.eventListeners[event].filter(h => h !== handler);
  }

  private emit(event: string, data: any) {
    this.eventListeners[event]?.forEach(h => h(data));
  }

  public destroy() {
    this.connected = false;
    this.ready = false;
    this.isDestroyed = true; // 🚀 [추가] 파괴 상태 설정
    this.dataChannels.forEach(ch => ch.close());
    this.dataChannels = [];
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.eventListeners = {};
    logInfo(`[NativePeer ${this.id}]`, 'Destroyed');
  }

  /**
   * 🚀 네트워크 핸드오버 처리 (Debounce 적용)
   */
  private handleDisconnect() {
    if (this.isReconnecting) return;
    this.connected = false;
    this.isReconnecting = true;
    
    // UI에 '재연결 중...' 상태 알림
    this.emit('reconnecting', true);

    // 2초 정도 기다려보고(일시적 장애일 수 있음) 여전히 끊겨있으면 Restart
    this.reconnectTimer = setTimeout(() => {
        if (this.pc && this.pc.iceConnectionState !== 'connected') {
            this.restartIce();
        }
    }, 2000);
  }

  /**
   * 🚀 ICE Restart 실행
   * 새로운 ufrag/pwd를 생성하여 IP가 바뀌어도 연결을 복구함
   */
  public async restartIce() {
    if (!this.pc || !this.config.isInitiator) return; // Initiator만 Restart 주도

    logInfo(`[NativePeer ${this.id}]`, '🔄 Triggering ICE Restart...');

    try {
      // iceRestart: true 옵션이 핵심
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      
      // 변경된 SDP(새로운 후보자 정보 포함) 전송
      this.emit('signal', {
        type: 'offer',
        sdp: this.pc.localDescription?.sdp,
        restart: true // 시그널링 서버에 재시작임을 알림 (선택사항)
      });
    } catch (e) {
      logError(`[NativePeer ${this.id}]`, 'ICE Restart failed', e);
      this.emit('error', 'Connection recovery failed');
    }
  }
}