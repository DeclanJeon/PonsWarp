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
} from '../constants';

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
    mode: 'slow_start',
    cwnd: 1024 * 1024,           // 🚀 초기 1MB로 증가 (더 공격적)
    ssthresh: 8 * 1024 * 1024,   // 🚀 8MB로 증가
    estimatedBw: 0,
    estimatedRtt: 50              // 🚀 초기 추정 50ms (낙관적)
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
    batchSize: 16,
    sendRate: 0,
    bufferTarget: MAX_BUFFERED_AMOUNT / 2
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
    logInfo('[NetworkController]', 'Started');
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


  private updateCongestionControl(bufferedAmount: number): void {
    const utilization = bufferedAmount / MAX_BUFFERED_AMOUNT;
    const { mode, cwnd, ssthresh } = this.congestionState;

    if (utilization > 0.9) {
      this.congestionState.ssthresh = Math.max(cwnd / 2, 256 * 1024);
      this.congestionState.cwnd = this.congestionState.ssthresh;
      this.congestionState.mode = 'congestion_avoidance';
      this.consecutiveIncreases = 0;
      logInfo('[NetworkController]', `Congestion: cwnd ${(cwnd/1024).toFixed(0)}KB -> ${(this.congestionState.cwnd/1024).toFixed(0)}KB`);
      return;
    }

    if (utilization < 0.5) {
      if (mode === 'slow_start') {
        if (cwnd < ssthresh) {
          // 🚀 더 공격적인 Slow Start (2배 증가)
          this.congestionState.cwnd = Math.min(cwnd * 2, ssthresh);
        } else {
          this.congestionState.mode = 'congestion_avoidance';
        }
      } else {
        // 🚀 더 빠른 증가 (매번 증가, 128KB씩)
        this.consecutiveIncreases++;
        if (this.consecutiveIncreases >= 2) {
          this.congestionState.cwnd = Math.min(cwnd + 128 * 1024, MAX_BUFFERED_AMOUNT * 2);
          this.consecutiveIncreases = 0;
        }
      }
    }

    // 🚀 CWND 범위 확대 (최대 4MB까지)
    this.congestionState.cwnd = Math.max(512 * 1024, Math.min(MAX_BUFFERED_AMOUNT * 2, this.congestionState.cwnd));
  }

  private updateAdaptiveParams(): void {
    const { cwnd, estimatedRtt } = this.congestionState;

    if (estimatedRtt < 50) {
      this.adaptiveParams.chunkSize = CHUNK_SIZE_MAX;
    } else if (estimatedRtt < 150) {
      this.adaptiveParams.chunkSize = 64 * 1024;
    } else {
      this.adaptiveParams.chunkSize = 32 * 1024;
    }

    const optimalBatch = Math.floor(cwnd / this.adaptiveParams.chunkSize);
    this.adaptiveParams.batchSize = Math.max(
      BATCH_SIZE_MIN,
      Math.min(BATCH_SIZE_MAX, optimalBatch)
    );

    this.adaptiveParams.sendRate = this.congestionState.estimatedBw > 0 
      ? this.congestionState.estimatedBw 
      : this.metrics.throughput;
    this.adaptiveParams.bufferTarget = cwnd * 0.5;
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
      mode: 'slow_start',
      cwnd: 1024 * 1024,           // 🚀 초기 1MB
      ssthresh: 8 * 1024 * 1024,   // 🚀 8MB
      estimatedBw: 0,
      estimatedRtt: 50              // 🚀 초기 추정 50ms
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
      batchSize: 16,
      sendRate: 0,
      bufferTarget: MAX_BUFFERED_AMOUNT / 2
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
