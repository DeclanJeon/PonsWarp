/**
 * 🚀 [Phase 3] Multi-Channel Manager
 * 
 * WebRTC 멀티 채널 전략 구현
 * - 여러 DataChannel을 통한 병렬 전송
 * - 채널별 버퍼 상태 기반 로드 밸런싱
 * - 네트워크 상태 모니터링 및 동적 조절
 */

import { logInfo, logError } from '../utils/logger';
import {
  MAX_BUFFERED_AMOUNT,
  LOW_WATER_MARK,
  HIGH_WATER_MARK,
  CHUNK_SIZE_MAX
} from '../constants';

// ============================================================================
// 타입 정의
// ============================================================================

export interface ChannelStats {
  id: number;
  bufferedAmount: number;
  bytesSent: number;
  chunksSent: number;
  avgLatency: number;
  isHealthy: boolean;
}

export interface NetworkMetrics {
  estimatedBandwidth: number;  // bytes/s
  avgRtt: number;              // ms
  packetLoss: number;          // 0-1
  jitter: number;              // ms
}

export interface MultiChannelConfig {
  channelCount: number;        // 데이터 채널 수 (2-4 권장)
  enableLoadBalancing: boolean;
  enableAdaptiveChannels: boolean;
}

type ChannelReadyCallback = () => void;
type ChannelErrorCallback = (error: Error) => void;

// ============================================================================
// 멀티 채널 매니저
// ============================================================================

export class MultiChannelManager {
  private peerConnection: RTCPeerConnection | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private dataChannels: RTCDataChannel[] = [];
  private channelStats: Map<number, ChannelStats> = new Map();
  
  // 네트워크 메트릭
  private networkMetrics: NetworkMetrics = {
    estimatedBandwidth: 0,
    avgRtt: 0,
    packetLoss: 0,
    jitter: 0
  };
  
  // 로드 밸런싱 상태
  private currentChannelIndex = 0;
  private lastSendTimes: Map<number, number> = new Map();
  
  // 콜백
  private onAllChannelsReady: ChannelReadyCallback | null = null;
  private onChannelError: ChannelErrorCallback | null = null;
  
  // 설정
  private config: MultiChannelConfig = {
    channelCount: 3,
    enableLoadBalancing: true,
    enableAdaptiveChannels: true
  };

  constructor(config?: Partial<MultiChannelConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  // ============================================================================
  // 채널 생성 및 관리
  // ============================================================================

  /**
   * 멀티 채널 초기화 (Sender 측)
   */
  public initializeChannels(pc: RTCPeerConnection): void {
    this.peerConnection = pc;
    this.dataChannels = [];
    this.channelStats.clear();

    // 1. 컨트롤 채널 생성 (메타데이터, ACK, 제어 메시지)
    this.controlChannel = pc.createDataChannel('control', {
      ordered: true,
      protocol: 'control'
    });
    this.setupControlChannel(this.controlChannel);

    // 2. 데이터 채널들 생성 (파일 청크 전송)
    for (let i = 0; i < this.config.channelCount; i++) {
      const channel = pc.createDataChannel(`data-${i}`, {
        ordered: true,
        protocol: 'data',
        // @ts-ignore - bufferedAmountLowThreshold는 표준이지만 타입 정의에 없을 수 있음
        bufferedAmountLowThreshold: LOW_WATER_MARK
      });
      
      this.setupDataChannel(channel, i);
      this.dataChannels.push(channel);
      
      // 통계 초기화
      this.channelStats.set(i, {
        id: i,
        bufferedAmount: 0,
        bytesSent: 0,
        chunksSent: 0,
        avgLatency: 0,
        isHealthy: true
      });
    }

    logInfo('[MultiChannel]', `Initialized ${this.config.channelCount} data channels`);
  }

  /**
   * 멀티 채널 수신 설정 (Receiver 측)
   */
  public setupReceiverChannels(pc: RTCPeerConnection, onData: (data: ArrayBuffer) => void): void {
    this.peerConnection = pc;
    
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      
      if (channel.protocol === 'control') {
        this.controlChannel = channel;
        this.setupControlChannel(channel);
        logInfo('[MultiChannel]', 'Control channel received');
      } else if (channel.protocol === 'data') {
        const channelId = this.dataChannels.length;
        this.setupDataChannel(channel, channelId, onData);
        this.dataChannels.push(channel);
        
        this.channelStats.set(channelId, {
          id: channelId,
          bufferedAmount: 0,
          bytesSent: 0,
          chunksSent: 0,
          avgLatency: 0,
          isHealthy: true
        });
        
        logInfo('[MultiChannel]', `Data channel ${channelId} received`);
      }
    };
  }

  private setupControlChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    
    channel.onopen = () => {
      logInfo('[MultiChannel]', 'Control channel opened');
      this.checkAllChannelsReady();
    };
    
    channel.onerror = (e) => {
      logError('[MultiChannel]', 'Control channel error:', e);
    };
    
    channel.onclose = () => {
      logInfo('[MultiChannel]', 'Control channel closed');
    };
  }

  private setupDataChannel(
    channel: RTCDataChannel, 
    id: number, 
    onData?: (data: ArrayBuffer) => void
  ): void {
    channel.binaryType = 'arraybuffer';
    
    channel.onopen = () => {
      logInfo('[MultiChannel]', `Data channel ${id} opened`);
      this.checkAllChannelsReady();
    };
    
    channel.onbufferedamountlow = () => {
      // 버퍼가 비워지면 통계 업데이트
      const stats = this.channelStats.get(id);
      if (stats) {
        stats.bufferedAmount = channel.bufferedAmount;
      }
    };
    
    channel.onerror = (e) => {
      logError('[MultiChannel]', `Data channel ${id} error:`, e);
      const stats = this.channelStats.get(id);
      if (stats) {
        stats.isHealthy = false;
      }
      this.onChannelError?.(new Error(`Channel ${id} error`));
    };
    
    channel.onclose = () => {
      logInfo('[MultiChannel]', `Data channel ${id} closed`);
    };
    
    // Receiver 측 데이터 핸들러
    if (onData) {
      channel.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          onData(event.data);
        }
      };
    }
  }

  private checkAllChannelsReady(): void {
    const controlReady = this.controlChannel?.readyState === 'open';
    const allDataReady = this.dataChannels.every(ch => ch.readyState === 'open');
    
    if (controlReady && allDataReady && this.dataChannels.length === this.config.channelCount) {
      logInfo('[MultiChannel]', 'All channels ready');
      this.onAllChannelsReady?.();
    }
  }

  // ============================================================================
  // 로드 밸런싱 전략
  // ============================================================================

  /**
   * 🚀 [핵심] 최적 채널 선택 - 버퍼 여유가 가장 많은 채널
   */
  public getBestChannel(): RTCDataChannel | null {
    if (this.dataChannels.length === 0) return null;
    
    if (!this.config.enableLoadBalancing) {
      // 라운드 로빈
      return this.getRoundRobinChannel();
    }
    
    // 버퍼 여유가 가장 많은 채널 선택
    let bestChannel: RTCDataChannel | null = null;
    let lowestBuffer = Infinity;
    
    for (let i = 0; i < this.dataChannels.length; i++) {
      const channel = this.dataChannels[i];
      const stats = this.channelStats.get(i);
      
      // 건강하지 않은 채널 스킵
      if (!stats?.isHealthy || channel.readyState !== 'open') continue;
      
      if (channel.bufferedAmount < lowestBuffer) {
        lowestBuffer = channel.bufferedAmount;
        bestChannel = channel;
      }
    }
    
    return bestChannel || this.getRoundRobinChannel();
  }

  /**
   * 라운드 로빈 채널 선택
   */
  private getRoundRobinChannel(): RTCDataChannel | null {
    const healthyChannels = this.dataChannels.filter((ch, i) => {
      const stats = this.channelStats.get(i);
      return stats?.isHealthy && ch.readyState === 'open';
    });
    
    if (healthyChannels.length === 0) return null;
    
    const channel = healthyChannels[this.currentChannelIndex % healthyChannels.length];
    this.currentChannelIndex++;
    return channel;
  }

  /**
   * 모든 채널에 데이터 분산 전송 (배치용)
   */
  public sendBatch(chunks: ArrayBuffer[]): { sent: number; failed: number } {
    let sent = 0;
    let failed = 0;
    
    for (const chunk of chunks) {
      const channel = this.getBestChannel();
      if (channel && this.sendToChannel(channel, chunk)) {
        sent++;
      } else {
        failed++;
      }
    }
    
    return { sent, failed };
  }

  /**
   * 특정 채널로 데이터 전송
   */
  private sendToChannel(channel: RTCDataChannel, data: ArrayBuffer): boolean {
    try {
      if (channel.readyState !== 'open') return false;
      if (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) return false;
      
      const channelId = this.dataChannels.indexOf(channel);
      const sendStart = performance.now();
      
      channel.send(data);
      
      // 통계 업데이트
      const stats = this.channelStats.get(channelId);
      if (stats) {
        stats.bytesSent += data.byteLength;
        stats.chunksSent++;
        stats.bufferedAmount = channel.bufferedAmount;
        
        // 지연 시간 계산 (이동 평균)
        const lastSend = this.lastSendTimes.get(channelId) || sendStart;
        const latency = sendStart - lastSend;
        stats.avgLatency = stats.avgLatency * 0.8 + latency * 0.2;
        this.lastSendTimes.set(channelId, sendStart);
      }
      
      return true;
    } catch (e) {
      logError('[MultiChannel]', 'Send failed:', e);
      return false;
    }
  }

  // ============================================================================
  // 네트워크 메트릭 수집
  // ============================================================================

  /**
   * WebRTC 통계 수집 및 네트워크 메트릭 업데이트
   */
  public async updateNetworkMetrics(): Promise<NetworkMetrics> {
    if (!this.peerConnection) return this.networkMetrics;
    
    try {
      const stats = await this.peerConnection.getStats();
      
      let totalBytesSent = 0;
      let totalBytesReceived = 0;
      let rttSum = 0;
      let rttCount = 0;
      let packetsLost = 0;
      let packetsTotal = 0;
      
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          if (report.currentRoundTripTime) {
            rttSum += report.currentRoundTripTime * 1000; // ms로 변환
            rttCount++;
          }
          if (report.availableOutgoingBitrate) {
            this.networkMetrics.estimatedBandwidth = report.availableOutgoingBitrate / 8; // bytes/s
          }
        }
        
        if (report.type === 'outbound-rtp') {
          totalBytesSent += report.bytesSent || 0;
          packetsTotal += report.packetsSent || 0;
        }
        
        if (report.type === 'inbound-rtp') {
          totalBytesReceived += report.bytesReceived || 0;
          packetsLost += report.packetsLost || 0;
        }
      });
      
      // 메트릭 업데이트
      if (rttCount > 0) {
        this.networkMetrics.avgRtt = rttSum / rttCount;
      }
      
      if (packetsTotal > 0) {
        this.networkMetrics.packetLoss = packetsLost / packetsTotal;
      }
      
    } catch (e) {
      logError('[MultiChannel]', 'Failed to get stats:', e);
    }
    
    return this.networkMetrics;
  }

  // ============================================================================
  // 적응형 채널 관리
  // ============================================================================

  /**
   * 네트워크 상태에 따른 채널 수 조절 권장
   */
  public getRecommendedChannelCount(): number {
    const { estimatedBandwidth, avgRtt, packetLoss } = this.networkMetrics;
    
    // 기본값
    let recommended = this.config.channelCount;
    
    // 대역폭 기반 조절
    if (estimatedBandwidth > 0) {
      const mbps = estimatedBandwidth / (1024 * 1024);
      
      if (mbps > 100) {
        recommended = 4; // 고속 네트워크
      } else if (mbps > 50) {
        recommended = 3;
      } else if (mbps > 10) {
        recommended = 2;
      } else {
        recommended = 1; // 저속 네트워크
      }
    }
    
    // RTT 기반 조절
    if (avgRtt > 200) {
      recommended = Math.max(1, recommended - 1); // 고지연 환경
    }
    
    // 패킷 손실 기반 조절
    if (packetLoss > 0.05) {
      recommended = Math.max(1, recommended - 1); // 불안정한 네트워크
    }
    
    return Math.min(4, Math.max(1, recommended));
  }

  /**
   * 전체 버퍼 상태 확인
   */
  public getTotalBufferedAmount(): number {
    return this.dataChannels.reduce((sum, ch) => sum + ch.bufferedAmount, 0);
  }

  /**
   * 전송 가능 여부 확인
   */
  public canSend(): boolean {
    return this.dataChannels.some(ch => 
      ch.readyState === 'open' && 
      ch.bufferedAmount < HIGH_WATER_MARK
    );
  }

  /**
   * 모든 채널의 버퍼가 비워질 때까지 대기
   */
  public async waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const totalBuffered = this.getTotalBufferedAmount();
        if (totalBuffered === 0) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  // ============================================================================
  // 컨트롤 채널 메시지
  // ============================================================================

  /**
   * 컨트롤 메시지 전송
   */
  public sendControlMessage(message: object): boolean {
    if (!this.controlChannel || this.controlChannel.readyState !== 'open') {
      return false;
    }
    
    try {
      this.controlChannel.send(JSON.stringify(message));
      return true;
    } catch (e) {
      logError('[MultiChannel]', 'Control message failed:', e);
      return false;
    }
  }

  /**
   * 컨트롤 메시지 핸들러 설정
   */
  public setControlMessageHandler(handler: (message: any) => void): void {
    if (this.controlChannel) {
      this.controlChannel.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          handler(message);
        } catch (e) {
          logError('[MultiChannel]', 'Invalid control message:', e);
        }
      };
    }
  }

  // ============================================================================
  // 이벤트 핸들러
  // ============================================================================

  public onReady(callback: ChannelReadyCallback): void {
    this.onAllChannelsReady = callback;
  }

  public onError(callback: ChannelErrorCallback): void {
    this.onChannelError = callback;
  }

  // ============================================================================
  // 통계 및 정리
  // ============================================================================

  public getChannelStats(): ChannelStats[] {
    return Array.from(this.channelStats.values());
  }

  public getNetworkMetrics(): NetworkMetrics {
    return { ...this.networkMetrics };
  }

  public cleanup(): void {
    this.controlChannel?.close();
    this.dataChannels.forEach(ch => ch.close());
    
    this.controlChannel = null;
    this.dataChannels = [];
    this.channelStats.clear();
    this.lastSendTimes.clear();
    this.peerConnection = null;
    
    logInfo('[MultiChannel]', 'Cleaned up');
  }
}

// 싱글톤 인스턴스 (선택적 사용)
export const multiChannelManager = new MultiChannelManager();
