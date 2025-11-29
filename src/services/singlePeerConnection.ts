/**
 * SinglePeerConnection (Native WebRTC Implementation)
 * Native RTCPeerConnection으로 구현된 WebRTC 연결 클래스입니다.
 * Multi-Channel(병렬 전송)을 지원하며, SwarmManager와의 호환성을 유지합니다.
 */
import { LOW_WATER_MARK, MULTI_CHANNEL_COUNT } from '../utils/constants';
import { logInfo, logError, logWarn } from '../utils/logger';
import { optimizeSDP } from '../utils/sdpUtils'; // 🚀 추가

type EventHandler = (data: any) => void;

export interface PeerConfig {
  iceServers: RTCIceServer[];
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
  
  private pc: RTCPeerConnection | null = null;
  private dataChannels: RTCDataChannel[] = [];
  private eventListeners: Record<string, EventHandler[]> = {};
  private isInitiator: boolean;
  private config: PeerConfig;
  private isDestroyed: boolean = false;

  // Round-Robin 로드 밸런싱 인덱스
  private nextChannelIndex = 0;

  constructor(peerId: string, initiator: boolean, config: PeerConfig) {
    this.id = peerId;
    this.isInitiator = initiator;
    this.config = config;
    this.initialize();
  }

  private initialize() {
    logInfo(`[NativePeer ${this.id}]`, `Initializing (Initiator: ${this.isInitiator})`);

    try {
      this.pc = new RTCPeerConnection({
        iceServers: this.config.iceServers,
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      });

      // 1. ICE Candidate 핸들링
      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          // 시그널 포맷 (명시적 직렬화)
          const signalData = {
            candidate: {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              usernameFragment: event.candidate.usernameFragment
            }
          };
          this.emit('signal', signalData);
        }
      };

      // 2. 연결 상태 모니터링
      this.pc.onconnectionstatechange = () => {
        const state = this.pc?.connectionState;
        logInfo(`[NativePeer ${this.id}]`, `Connection State: ${state}`);
        
        if (state === 'connected') {
          if (!this.connected) {
            this.connected = true;
            // Receiver는 채널이 열릴 때까지 대기하므로 여기서 이벤트를 발생시키지 않음
            if (this.isInitiator) {
               this.emit('connected', this.id);
            }
          }
        } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          this.handleClose();
        }
      };

      this.pc.oniceconnectionstatechange = () => {
        const state = this.pc?.iceConnectionState;
        logInfo(`[NativePeer ${this.id}]`, `ICE State: ${state}`);
        if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          this.handleClose();
        }
      };

      // 3. Sender: 데이터 채널 생성
      if (this.isInitiator) {
        this.createDataChannels();
        this.createOffer();
      } else {
        // 4. Receiver: 데이터 채널 수신 대기
        this.pc.ondatachannel = (event) => {
          this.setupChannel(event.channel);
          
          // 첫 번째 채널이 연결되면 'connected'로 간주 (SwarmManager 호환성)
          if (this.dataChannels.length === 1 && !this.connected) {
            this.connected = true;
            this.emit('connected', this.id);
          }
        };
      }

    } catch (error) {
      logError(`[NativePeer ${this.id}]`, 'Initialization failed', error);
      this.emit('error', error);
    }
  }

  /**
   * 🚀 [Multi-Channel] 병렬 데이터 채널 생성
   */
  private createDataChannels() {
    if (!this.pc) return;

    for (let i = 0; i < MULTI_CHANNEL_COUNT; i++) {
      const label = `warp-ch-${i}`;
      try {
        const channel = this.pc.createDataChannel(label, {
          ordered: true, // 파일 전송 순서 보장을 위해 true (추후 최적화 가능)
        });
        this.setupChannel(channel);
      } catch (e) {
        logError(`[NativePeer ${this.id}]`, `Failed to create channel ${i}`, e);
      }
    }
  }

  private setupChannel(channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    // Backpressure 제어를 위한 임계값
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;

    channel.onopen = () => {
      logInfo(`[NativePeer ${this.id}]`, `Channel ${channel.label} OPEN`);
    };

    channel.onmessage = (event) => {
      this.emit('data', event.data);
    };

    channel.onerror = (event) => {
      logError(`[NativePeer ${this.id}]`, `Channel ${channel.label} Error`, event);
    };

    channel.onclose = () => {
      logWarn(`[NativePeer ${this.id}]`, `Channel ${channel.label} Closed`);
      this.dataChannels = this.dataChannels.filter(c => c !== channel);
    };

    // Flow Control: 버퍼 드레인 이벤트
    channel.onbufferedamountlow = () => {
      this.emit('drain', this.id);
    };

    this.dataChannels.push(channel);
  }

  // === Signaling Logic ===

  private async createOffer() {
    if (!this.pc) return;
    try {
      const offer = await this.pc.createOffer();
      
      // 🚀 [Step 15] Local SDP 최적화 (Munching)
      // 상대방에게 보내기 전에 내 SDP를 수정하여 "나는 엄청난 속도를 원해!"라고 선언
      const mungedSdp = optimizeSDP(offer.sdp || '');
      
      const optimizedOffer = {
        type: offer.type,
        sdp: mungedSdp
      };

      await this.pc.setLocalDescription(optimizedOffer);
      
      // 🚨 [FIX] setLocalDescription 이후 pc.localDescription 사용
      const localDesc = this.pc.localDescription;
      if (!localDesc || !localDesc.sdp) {
        logError(`[NativePeer ${this.id}]`, 'Local description is null after setLocalDescription');
        return;
      }
      
      // 시그널 포맷 (명시적 직렬화)
      const signalData = {
        type: localDesc.type as 'offer',
        sdp: localDesc.sdp
      };
      
      logInfo(`[NativePeer ${this.id}]`, `Offer created, SDP length: ${signalData.sdp.length}`);
      this.emit('signal', signalData);
    } catch (e) {
      this.emit('error', e);
    }
  }

  /**
   * 외부 시그널 데이터 처리
   */
  public async signal(data: any) {
    if (this.isDestroyed || !this.pc) return;

    try {
      console.log(`[NativePeer ${this.id}] 🔍 Signal data received:`, {
        dataType: typeof data,
        dataKeys: data ? Object.keys(data) : [],
        hasType: !!data?.type,
        hasSdp: !!data?.sdp,
        hasCandidate: !!data?.candidate,
        type: data?.type,
        sdpLength: data?.sdp?.length,
        fullData: data
      });

      if (data.type === 'offer') {
        // 상대방의 Offer를 받았을 때
        if (!data.sdp) {
          logError(`[NativePeer ${this.id}]`, 'Missing SDP in signal data', data);
          return;
        }

        await this.pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await this.pc.createAnswer();
        
        // 🚀 [Step 15] Answer SDP 최적화
        const mungedSdp = optimizeSDP(answer.sdp || '');
        const optimizedAnswer = {
          type: answer.type,
          sdp: mungedSdp
        };

        await this.pc.setLocalDescription(optimizedAnswer);
        
        // 🚨 [FIX] setLocalDescription 이후 pc.localDescription 사용
        const localDesc = this.pc.localDescription;
        if (!localDesc || !localDesc.sdp) {
          logError(`[NativePeer ${this.id}]`, 'Local description is null after setLocalDescription');
          return;
        }
        
        // 시그널 포맷 (명시적 직렬화)
        const signalData = {
          type: localDesc.type as 'answer',
          sdp: localDesc.sdp
        };
        
        logInfo(`[NativePeer ${this.id}]`, `Answer created, SDP length: ${signalData.sdp.length}`);
        this.emit('signal', signalData);

      } else if (data.type === 'answer') {
        // 상대방의 Answer를 받았을 때
        if (!data.sdp) {
          logError(`[NativePeer ${this.id}]`, 'Missing SDP in signal data', data);
          return;
        }

        await this.pc.setRemoteDescription(new RTCSessionDescription(data));

      } else if (data.candidate) {
        await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (e) {
      logError(`[NativePeer ${this.id}]`, 'Signaling Error', e);
    }
  }

  // === Data Transmission ===

  /**
   * 🚀 [Load Balancing] 데이터 전송
   * 버퍼가 가장 비어있는 채널을 찾아 전송합니다.
   */
  public send(data: ArrayBuffer | string): void {
    if (this.dataChannels.length === 0) return;

    // 1. 가장 여유로운 채널 찾기
    let bestChannel: RTCDataChannel | null = null;
    let minBuffer = Infinity;

    for (const ch of this.dataChannels) {
      if (ch.readyState === 'open') {
        if (ch.bufferedAmount < minBuffer) {
          minBuffer = ch.bufferedAmount;
          bestChannel = ch;
        }
      }
    }

    // 2. 전송 (모든 채널이 닫혀있거나 꽉 찼으면 실패)
    if (bestChannel) {
      try {
        bestChannel.send(data as any);
      } catch (e) {
        logError(`[NativePeer ${this.id}]`, 'Send failed', e);
      }
    } else {
      // 대안: Round Robin 시도 (혹시 모르니)
      const rrChannel = this.dataChannels[this.nextChannelIndex % this.dataChannels.length];
      this.nextChannelIndex++;
      if (rrChannel?.readyState === 'open') {
        rrChannel.send(data as any);
      }
    }
  }

  /**
   * 전체 채널의 총 버퍼량 조회
   */
  public getBufferedAmount(): number {
    return this.dataChannels.reduce((acc, ch) => acc + ch.bufferedAmount, 0);
  }

  public getState(): PeerState {
    return {
      id: this.id,
      connected: this.connected,
      bufferedAmount: this.getBufferedAmount(),
      ready: this.ready
    };
  }

  // === Event Emitter ===

  public on(event: string, handler: EventHandler): void {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(handler);
  }

  public off(event: string, handler: EventHandler): void {
    if (!this.eventListeners[event]) return;
    this.eventListeners[event] = this.eventListeners[event].filter(h => h !== handler);
  }

  private emit(event: string, data?: any): void {
    this.eventListeners[event]?.forEach(h => h(data));
  }

  public removeAllListeners(): void {
    this.eventListeners = {};
  }

  // === Cleanup ===

  private handleClose() {
    if (this.connected) {
      this.connected = false;
      this.emit('close', null);
    }
  }

  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.connected = false;
    this.ready = false;

    try {
      this.dataChannels.forEach(ch => ch.close());
      this.pc?.close();
    } catch (e) {
      // ignore
    }

    this.pc = null;
    this.dataChannels = [];
    this.removeAllListeners();
    logInfo(`[NativePeer ${this.id}]`, 'Destroyed');
  }
}
