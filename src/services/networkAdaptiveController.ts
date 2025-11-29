/**
 * 🚀 [Phase 3] Network Adaptive Controller - 안정화 버전
 * 
 * 네트워크 상태 기반 동적 조절
 * - 실시간 대역폭 추정 (버퍼 드레인 기반)
 * - WebRTC 통계 기반 RTT 측정
 * - 단순화된 AIMD 혼잡 제어
 * - 안정성 우선 설계
 */

import { logInfo } from '../utils/logger';
import {
  CHUNK_SIZE_MIN,
  CHUNK_SIZE_MAX,
  BATCH_SIZE_MIN,
  BATCH_SIZE_MAX,
  MAX_BUFFERED_AMOUNT
} from '../utils/constants';

export interface CongestionState {
  mode: 'slow_start' | 'congestion_avoidance' | 'fast_recovery';
  cwnd: number;
  ssthresh: number;
  estimatedBw: number;
  estimatedRtt: number;
}

export interface AdaptiveParams {
  chunkSize: number;
  batchSize: number;
  sendRate: number;
  bufferTarget: number;
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
  throughput: number;
}


export class NetworkAdaptiveController {
  private congestionState: CongestionState = {
    mode: 'congestion_avoidance', // 🚨 [수정] slow_start 건너뛰기
    cwnd: MAX_BUFFERED_AMOUNT,    // 🚀 [수정] 초기 윈도우를 최대(16MB)로 설정 -> 4MB/s 제한 해제
    ssthresh: MAX_BUFFERED_AMOUNT,
    estimatedBw: 0,
    estimatedRtt: 5               // 🚀 [수정] LAN 환경 가정 (5ms)
  };

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
    batchSize: 128,              // 🚀 [수정] 배치를 처음부터 최대(128개, 약 16MB)로 고정
    sendRate: 0,
    bufferTarget: MAX_BUFFERED_AMOUNT
  };

  private startTime = 0;
  private lastUpdateTime = 0;
  private lastBytesSent = 0;
  private rttSamples: number[] = [];
  private throughputSamples: number[] = [];
  private consecutiveIncreases = 0;
  private lastBufferedAmount = 0;

  private readonly RTT_SAMPLE_SIZE = 20;
  private readonly THROUGHPUT_SAMPLE_SIZE = 10;
  private readonly UPDATE_INTERVAL_MS = 100;

  constructor() {
    this.reset();
  }

  public start(): void {
    this.startTime = performance.now();
    this.lastUpdateTime = this.startTime;
    logInfo('[NetworkController]', 'Started (Aggressive Mode)');
  }

  public recordSend(bytes: number): void {
    this.metrics.bytesSent += bytes;
    this.metrics.chunksInFlight++;
  }

  public updateBufferState(bufferedAmount: number): void {
    const now = performance.now();
    const elapsed = now - this.lastUpdateTime;

    if (this.lastBufferedAmount > bufferedAmount && elapsed > 0) {
      const drained = this.lastBufferedAmount - bufferedAmount;
      const drainRate = drained / (elapsed / 1000);
      
      if (drainRate > 0) {
        this.congestionState.estimatedBw = this.congestionState.estimatedBw === 0
          ? drainRate
          : this.congestionState.estimatedBw * 0.8 + drainRate * 0.2;
      }
    }

    if (elapsed >= this.UPDATE_INTERVAL_MS) {
      const bytesDelta = this.metrics.bytesSent - this.lastBytesSent;
      const throughput = bytesDelta / (elapsed / 1000);
      
      this.throughputSamples.push(throughput);
      if (this.throughputSamples.length > this.THROUGHPUT_SAMPLE_SIZE) {
        this.throughputSamples.shift();
      }
      
      this.metrics.throughput = this.throughputSamples.reduce((a, b) => a + b, 0) 
        / this.throughputSamples.length;
      
      this.lastBytesSent = this.metrics.bytesSent;
      this.lastUpdateTime = now;
    }

    this.lastBufferedAmount = bufferedAmount;
    this.updateCongestionControl(bufferedAmount);
    this.updateAdaptiveParams();
  }

  public recordRtt(rttMs: number): void {
    if (rttMs <= 0 || rttMs > 10000) return;

    this.rttSamples.push(rttMs);
    if (this.rttSamples.length > this.RTT_SAMPLE_SIZE) {
      this.rttSamples.shift();
    }

    this.metrics.lastRtt = rttMs;
    this.metrics.minRtt = Math.min(this.metrics.minRtt, rttMs);
    this.metrics.maxRtt = Math.max(this.metrics.maxRtt, rttMs);
    this.metrics.avgRtt = this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length;
    this.congestionState.estimatedRtt = this.metrics.avgRtt;
  }

  public updateFromWebRTCStats(stats: RTCStatsReport): void {
    stats.forEach((report: any) => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        if (report.currentRoundTripTime !== undefined) {
          this.recordRtt(report.currentRoundTripTime * 1000);
        }
        if (report.availableOutgoingBitrate !== undefined) {
          const bwBytesPerSec = report.availableOutgoingBitrate / 8;
          this.congestionState.estimatedBw = this.congestionState.estimatedBw === 0
            ? bwBytesPerSec
            : this.congestionState.estimatedBw * 0.7 + bwBytesPerSec * 0.3;
        }
      }
    });
  }


  // 🚀 [핵심] 혼잡 제어 로직을 "LAN 환경"에 맞게 관대하게 변경
  private updateCongestionControl(bufferedAmount: number): void {
    const { lossRate } = this.metrics;
    const { estimatedRtt } = this.congestionState;

    // 패킷 손실이 감지되어도 LAN에서는 무시하거나 아주 조금만 줄임
    // 🚨 [수정] RTT가 200ms 이상 튀지 않는 한 윈도우를 줄이지 않음
    if (estimatedRtt > 200) { // 아주 심각할 때만 90%로 축소 (기존 50% 축소 로직 제거)
      this.congestionState.cwnd = Math.max(this.congestionState.cwnd * 0.9, 8 * 1024 * 1024);
      return;
    }

    // 기본적으로 항상 최대 윈도우 유지 시도 (Speed Limit 해제)
    this.congestionState.cwnd = MAX_BUFFERED_AMOUNT;
  }

  private updateAdaptiveParams(): void {
    // 🚀 [수정] 배치 사이즈 동적 계산 무시하고 항상 최대값 유지
    this.adaptiveParams.chunkSize = CHUNK_SIZE_MAX;
    this.adaptiveParams.batchSize = 128; // 128개 * 128KB = 16MB 배치

    this.adaptiveParams.sendRate = this.congestionState.estimatedBw > 0 
      ? this.congestionState.estimatedBw 
      : this.metrics.throughput;
    this.adaptiveParams.bufferTarget = this.congestionState.cwnd * 0.8;
  }

  public canSend(currentBuffered: number): boolean {
    return currentBuffered < this.congestionState.cwnd;
  }

  public getAdaptiveParams(): AdaptiveParams {
    return { ...this.adaptiveParams };
  }

  public getMetrics(): TransferMetrics {
    return { ...this.metrics };
  }

  public getCongestionState(): CongestionState {
    return { ...this.congestionState };
  }

  public reset(): void {
    this.congestionState = {
      mode: 'congestion_avoidance',
      cwnd: MAX_BUFFERED_AMOUNT,
      ssthresh: MAX_BUFFERED_AMOUNT,
      estimatedBw: 0,
      estimatedRtt: 5
    };

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
      batchSize: 128,
      sendRate: 0,
      bufferTarget: MAX_BUFFERED_AMOUNT
    };

    this.startTime = 0;
    this.lastUpdateTime = 0;
    this.lastBytesSent = 0;
    this.rttSamples = [];
    this.throughputSamples = [];
    this.consecutiveIncreases = 0;
    this.lastBufferedAmount = 0;
  }

  public getDebugInfo(): object {
    return {
      congestion: this.congestionState,
      metrics: this.metrics,
      params: this.adaptiveParams,
      rttSamples: this.rttSamples.slice(-5),
      throughputMBps: (this.metrics.throughput / (1024 * 1024)).toFixed(2)
    };
  }
}

export const networkController = new NetworkAdaptiveController();
