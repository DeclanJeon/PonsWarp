/**
 * 🚀 [Phase 3] Network Adaptive Controller
 * 
 * 네트워크 상태 기반 동적 조절 고도화
 * - 실시간 대역폭 추정
 * - RTT 기반 청크 크기 조절
 * - 패킷 손실 감지 및 대응
 * - 혼잡 제어 알고리즘 (BBR 변형)
 */

import { logInfo, logError } from '../utils/logger';
import {
  CHUNK_SIZE_MIN,
  CHUNK_SIZE_MAX,
  BATCH_SIZE_MIN,
  BATCH_SIZE_MAX,
  MAX_BUFFERED_AMOUNT,
  LOW_WATER_MARK,
  HIGH_WATER_MARK
} from '../constants';

// ============================================================================
// 타입 정의
// ============================================================================

export interface BandwidthSample {
  timestamp: number;
  bytes: number;
  rtt: number;
}

export interface CongestionState {
  mode: 'startup' | 'drain' | 'probe_bw' | 'probe_rtt';
  cwnd: number;           // Congestion window (bytes)
  btlBw: number;          // Bottleneck bandwidth (bytes/s)
  rtProp: number;         // Round-trip propagation time (ms)
  pacingGain: number;     // Pacing gain multiplier
  cwndGain: number;       // CWND gain multiplier
}

export interface AdaptiveParams {
  chunkSize: number;
  batchSize: number;
  sendRate: number;       // bytes/s
  bufferTarget: number;   // target buffer level
}

export interface TransferMetrics {
  bytesSent: number;
  bytesAcked: number;
  chunksInFlight: number;
  lastRtt: number;
  minRtt: number;
  maxRtt: number;
  avgRtt: number;
  lossRate: number;
  throughput: number;     // bytes/s
}

// ============================================================================
// BBR 변형 혼잡 제어
// ============================================================================

class BBRController {
  private state: CongestionState = {
    mode: 'startup',
    cwnd: 10 * CHUNK_SIZE_MAX,  // 초기 CWND
    btlBw: 0,
    rtProp: Infinity,
    pacingGain: 2.89,     // Startup gain
    cwndGain: 2.89
  };

  private bwSamples: BandwidthSample[] = [];
  private readonly BW_WINDOW_SIZE = 10;
  private readonly RTT_WINDOW_SIZE = 10;
  private rttSamples: number[] = [];
  
  private probeRttDuration = 200;  // ms
  private probeRttStartTime = 0;
  private cycleIndex = 0;
  private readonly PACING_GAINS = [1.25, 0.75, 1, 1, 1, 1, 1, 1];

  /**
   * 대역폭 샘플 추가
   */
  public addBandwidthSample(bytes: number, rtt: number): void {
    const now = performance.now();
    
    this.bwSamples.push({ timestamp: now, bytes, rtt });
    
    // 윈도우 크기 유지
    if (this.bwSamples.length > this.BW_WINDOW_SIZE) {
      this.bwSamples.shift();
    }
    
    // RTT 샘플 추가
    this.rttSamples.push(rtt);
    if (this.rttSamples.length > this.RTT_WINDOW_SIZE) {
      this.rttSamples.shift();
    }
    
    // 최소 RTT 업데이트
    if (rtt < this.state.rtProp) {
      this.state.rtProp = rtt;
    }
    
    // 대역폭 추정
    this.updateBtlBw();
    
    // 상태 전이
    this.updateState();
  }

  /**
   * 병목 대역폭 추정 (최대 전달률)
   */
  private updateBtlBw(): void {
    if (this.bwSamples.length < 2) return;
    
    // 최근 샘플들의 최대 대역폭 계산
    let maxBw = 0;
    
    for (let i = 1; i < this.bwSamples.length; i++) {
      const prev = this.bwSamples[i - 1];
      const curr = this.bwSamples[i];
      const timeDelta = curr.timestamp - prev.timestamp;
      
      if (timeDelta > 0) {
        const bw = curr.bytes / (timeDelta / 1000);  // bytes/s
        maxBw = Math.max(maxBw, bw);
      }
    }
    
    // 이동 평균으로 안정화
    if (maxBw > 0) {
      this.state.btlBw = this.state.btlBw === 0 
        ? maxBw 
        : this.state.btlBw * 0.75 + maxBw * 0.25;
    }
  }

  /**
   * BBR 상태 전이
   */
  private updateState(): void {
    const { mode, btlBw, rtProp } = this.state;
    
    switch (mode) {
      case 'startup':
        // Startup: 대역폭이 더 이상 증가하지 않으면 Drain으로 전이
        if (this.bwSamples.length >= this.BW_WINDOW_SIZE) {
          const recentBw = this.getRecentBandwidth();
          if (recentBw < btlBw * 1.25) {
            this.enterDrain();
          }
        }
        break;
        
      case 'drain':
        // Drain: 버퍼가 비워지면 ProbeBW로 전이
        this.state.pacingGain = 0.75;
        this.state.cwndGain = 1;
        // 실제로는 inflight bytes 체크 필요
        this.enterProbeBW();
        break;
        
      case 'probe_bw':
        // ProbeBW: 주기적으로 대역폭 탐색
        this.cyclePacingGain();
        
        // 주기적으로 ProbeRTT 진입
        if (this.shouldProbeRtt()) {
          this.enterProbeRTT();
        }
        break;
        
      case 'probe_rtt':
        // ProbeRTT: 최소 RTT 측정
        const now = performance.now();
        if (now - this.probeRttStartTime > this.probeRttDuration) {
          this.enterProbeBW();
        }
        break;
    }
    
    // CWND 업데이트
    this.updateCwnd();
  }

  private enterDrain(): void {
    this.state.mode = 'drain';
    this.state.pacingGain = 0.75;
    logInfo('[BBR]', 'Entering DRAIN mode');
  }

  private enterProbeBW(): void {
    this.state.mode = 'probe_bw';
    this.cycleIndex = 0;
    this.state.pacingGain = this.PACING_GAINS[0];
    this.state.cwndGain = 2;
    logInfo('[BBR]', 'Entering PROBE_BW mode');
  }

  private enterProbeRTT(): void {
    this.state.mode = 'probe_rtt';
    this.probeRttStartTime = performance.now();
    this.state.cwnd = 4 * CHUNK_SIZE_MAX;  // 최소 CWND
    logInfo('[BBR]', 'Entering PROBE_RTT mode');
  }

  private cyclePacingGain(): void {
    this.cycleIndex = (this.cycleIndex + 1) % this.PACING_GAINS.length;
    this.state.pacingGain = this.PACING_GAINS[this.cycleIndex];
  }

  private shouldProbeRtt(): boolean {
    // 10초마다 ProbeRTT 진입
    return Math.random() < 0.01;
  }

  private updateCwnd(): void {
    const { btlBw, rtProp, cwndGain } = this.state;
    
    if (btlBw > 0 && rtProp < Infinity) {
      // BDP (Bandwidth-Delay Product) 기반 CWND
      const bdp = btlBw * (rtProp / 1000);
      this.state.cwnd = Math.max(
        4 * CHUNK_SIZE_MAX,
        Math.min(MAX_BUFFERED_AMOUNT, bdp * cwndGain)
      );
    }
  }

  private getRecentBandwidth(): number {
    if (this.bwSamples.length < 2) return 0;
    
    const recent = this.bwSamples.slice(-3);
    let totalBytes = 0;
    let totalTime = 0;
    
    for (let i = 1; i < recent.length; i++) {
      totalBytes += recent[i].bytes;
      totalTime += recent[i].timestamp - recent[i - 1].timestamp;
    }
    
    return totalTime > 0 ? totalBytes / (totalTime / 1000) : 0;
  }

  /**
   * 현재 전송 파라미터 반환
   */
  public getParams(): { cwnd: number; pacingRate: number; mode: string } {
    const { cwnd, btlBw, pacingGain, mode } = this.state;
    const pacingRate = btlBw * pacingGain;
    
    return { cwnd, pacingRate, mode };
  }

  public getState(): CongestionState {
    return { ...this.state };
  }

  public reset(): void {
    this.state = {
      mode: 'startup',
      cwnd: 10 * CHUNK_SIZE_MAX,
      btlBw: 0,
      rtProp: Infinity,
      pacingGain: 2.89,
      cwndGain: 2.89
    };
    this.bwSamples = [];
    this.rttSamples = [];
  }
}

// ============================================================================
// 네트워크 적응형 컨트롤러
// ============================================================================

export class NetworkAdaptiveController {
  private bbr = new BBRController();
  
  private metrics: TransferMetrics = {
    bytesSent: 0,
    bytesAcked: 0,
    chunksInFlight: 0,
    lastRtt: 0,
    minRtt: Infinity,
    maxRtt: 0,
    avgRtt: 0,
    lossRate: 0,
    throughput: 0
  };

  private adaptiveParams: AdaptiveParams = {
    chunkSize: CHUNK_SIZE_MAX,
    batchSize: 16,
    sendRate: 0,
    bufferTarget: MAX_BUFFERED_AMOUNT / 2
  };

  private startTime = 0;
  private lastUpdateTime = 0;
  private rttHistory: number[] = [];
  private throughputHistory: number[] = [];

  constructor() {
    this.reset();
  }

  /**
   * 전송 시작
   */
  public start(): void {
    this.startTime = performance.now();
    this.lastUpdateTime = this.startTime;
  }

  /**
   * 청크 전송 기록
   */
  public recordSend(bytes: number): void {
    this.metrics.bytesSent += bytes;
    this.metrics.chunksInFlight++;
  }

  /**
   * ACK 수신 기록 (RTT 측정)
   */
  public recordAck(bytes: number, rtt: number): void {
    this.metrics.bytesAcked += bytes;
    this.metrics.chunksInFlight = Math.max(0, this.metrics.chunksInFlight - 1);
    this.metrics.lastRtt = rtt;
    
    // RTT 통계 업데이트
    this.rttHistory.push(rtt);
    if (this.rttHistory.length > 100) {
      this.rttHistory.shift();
    }
    
    this.metrics.minRtt = Math.min(this.metrics.minRtt, rtt);
    this.metrics.maxRtt = Math.max(this.metrics.maxRtt, rtt);
    this.metrics.avgRtt = this.rttHistory.reduce((a, b) => a + b, 0) / this.rttHistory.length;
    
    // BBR에 샘플 추가
    this.bbr.addBandwidthSample(bytes, rtt);
    
    // 파라미터 업데이트
    this.updateAdaptiveParams();
  }

  /**
   * 버퍼 상태 업데이트
   */
  public updateBufferState(bufferedAmount: number): void {
    const now = performance.now();
    const elapsed = now - this.lastUpdateTime;
    
    if (elapsed > 100) {  // 100ms마다 업데이트
      // 처리량 계산
      const bytesDelta = this.metrics.bytesSent - (this.throughputHistory[0] || 0);
      this.metrics.throughput = bytesDelta / (elapsed / 1000);
      
      this.throughputHistory.push(this.metrics.bytesSent);
      if (this.throughputHistory.length > 10) {
        this.throughputHistory.shift();
      }
      
      this.lastUpdateTime = now;
      
      // 버퍼 상태 기반 조절
      this.adjustForBufferState(bufferedAmount);
    }
  }

  /**
   * 🚀 [핵심] 적응형 파라미터 업데이트
   */
  private updateAdaptiveParams(): void {
    const bbrParams = this.bbr.getParams();
    const { avgRtt, lossRate, throughput } = this.metrics;
    
    // 1. 청크 크기 조절 (RTT 기반)
    if (avgRtt > 0) {
      if (avgRtt < 50) {
        // 저지연: 큰 청크 사용
        this.adaptiveParams.chunkSize = CHUNK_SIZE_MAX;
      } else if (avgRtt < 150) {
        // 중간 지연: 기본 청크
        this.adaptiveParams.chunkSize = Math.floor((CHUNK_SIZE_MIN + CHUNK_SIZE_MAX) / 2);
      } else {
        // 고지연: 작은 청크로 응답성 향상
        this.adaptiveParams.chunkSize = CHUNK_SIZE_MIN;
      }
    }
    
    // 2. 배치 크기 조절 (CWND 기반)
    const optimalBatch = Math.floor(bbrParams.cwnd / this.adaptiveParams.chunkSize);
    this.adaptiveParams.batchSize = Math.max(
      BATCH_SIZE_MIN,
      Math.min(BATCH_SIZE_MAX, optimalBatch)
    );
    
    // 3. 전송 속도 조절 (BBR pacing rate)
    this.adaptiveParams.sendRate = bbrParams.pacingRate;
    
    // 4. 패킷 손실 대응
    if (lossRate > 0.05) {
      // 5% 이상 손실: 보수적 설정
      this.adaptiveParams.batchSize = Math.max(
        BATCH_SIZE_MIN,
        Math.floor(this.adaptiveParams.batchSize * 0.5)
      );
      this.adaptiveParams.bufferTarget = LOW_WATER_MARK;
    } else if (lossRate > 0.01) {
      // 1-5% 손실: 약간 보수적
      this.adaptiveParams.batchSize = Math.max(
        BATCH_SIZE_MIN,
        Math.floor(this.adaptiveParams.batchSize * 0.75)
      );
    }
  }

  /**
   * 버퍼 상태 기반 조절
   */
  private adjustForBufferState(bufferedAmount: number): void {
    const utilization = bufferedAmount / MAX_BUFFERED_AMOUNT;
    
    if (utilization > 0.8) {
      // 버퍼 거의 가득: 배치 크기 감소
      this.adaptiveParams.batchSize = Math.max(
        BATCH_SIZE_MIN,
        Math.floor(this.adaptiveParams.batchSize * 0.75)
      );
    } else if (utilization < 0.3) {
      // 버퍼 여유: 배치 크기 증가
      this.adaptiveParams.batchSize = Math.min(
        BATCH_SIZE_MAX,
        this.adaptiveParams.batchSize + 4
      );
    }
    
    // 버퍼 타겟 조절
    this.adaptiveParams.bufferTarget = MAX_BUFFERED_AMOUNT * (0.3 + utilization * 0.4);
  }

  /**
   * 패킷 손실 기록
   */
  public recordLoss(count: number = 1): void {
    const totalPackets = this.metrics.bytesSent / this.adaptiveParams.chunkSize;
    if (totalPackets > 0) {
      this.metrics.lossRate = count / totalPackets;
    }
  }

  /**
   * 현재 적응형 파라미터 반환
   */
  public getAdaptiveParams(): AdaptiveParams {
    return { ...this.adaptiveParams };
  }

  /**
   * 현재 메트릭 반환
   */
  public getMetrics(): TransferMetrics {
    return { ...this.metrics };
  }

  /**
   * BBR 상태 반환
   */
  public getCongestionState(): CongestionState {
    return this.bbr.getState();
  }

  /**
   * 전송 가능 여부 (CWND 기반)
   */
  public canSend(currentBuffered: number): boolean {
    const bbrParams = this.bbr.getParams();
    return currentBuffered < bbrParams.cwnd;
  }

  /**
   * 권장 대기 시간 (pacing)
   */
  public getPacingDelay(): number {
    const { sendRate } = this.adaptiveParams;
    if (sendRate <= 0) return 0;
    
    // 청크 하나 전송에 필요한 시간
    return (this.adaptiveParams.chunkSize / sendRate) * 1000;  // ms
  }

  /**
   * 상태 리셋
   */
  public reset(): void {
    this.bbr.reset();
    
    this.metrics = {
      bytesSent: 0,
      bytesAcked: 0,
      chunksInFlight: 0,
      lastRtt: 0,
      minRtt: Infinity,
      maxRtt: 0,
      avgRtt: 0,
      lossRate: 0,
      throughput: 0
    };
    
    this.adaptiveParams = {
      chunkSize: CHUNK_SIZE_MAX,
      batchSize: 16,
      sendRate: 0,
      bufferTarget: MAX_BUFFERED_AMOUNT / 2
    };
    
    this.startTime = 0;
    this.lastUpdateTime = 0;
    this.rttHistory = [];
    this.throughputHistory = [];
  }

  /**
   * 디버그 정보
   */
  public getDebugInfo(): object {
    return {
      metrics: this.metrics,
      params: this.adaptiveParams,
      bbr: this.bbr.getState(),
      rttHistory: this.rttHistory.slice(-10),
      throughputMBps: (this.metrics.throughput / (1024 * 1024)).toFixed(2)
    };
  }
}

// 싱글톤 인스턴스
export const networkController = new NetworkAdaptiveController();
