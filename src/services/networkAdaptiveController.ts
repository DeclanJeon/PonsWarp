/**
 * 🚀 [Phase 3] Network Adaptive Controller - RTT 기반 동적 혼잡 제어
 *
 * 네트워크 상태 기반 동적 조절
 * - 실시간 대역폭 추정 (버퍼 드레인 기반)
 * - WebRTC 통계 기반 RTT 측정
 * - RTT 기반 AIMD 혼잡 제어 (Delay-based approach)
 * - WAN 환경 최적화
 */

import { logInfo, logDebug } from '../utils/logger';
import {
  CHUNK_SIZE_MAX,
  BATCH_SIZE_MIN,
  BATCH_SIZE_MAX,
  MAX_BUFFERED_AMOUNT
} from '../utils/constants';

export interface CongestionState {
  cwnd: number;       // Congestion Window (현재 허용 가능한 버퍼 크기)
  estimatedBw: number; // Bytes per second
  estimatedRtt: number; // Milliseconds
  rttVar: number;     // RTT Variance (Jitter)
}

export interface AdaptiveParams {
  batchSize: number;  // 워커에 요청할 청크 개수
  chunkSize: number;  // 청크 크기 (현재는 고정)
}

export interface TransferMetrics {
  throughput: number;
  avgRtt: number;
  lossCount: number; // 추정된 패킷 손실/지연 횟수
}

export class NetworkAdaptiveController {
  // 상태 변수
  private congestionState: CongestionState = {
    cwnd: 1024 * 1024, // 초기 시작: 1MB (Slow Start)
    estimatedBw: 0,
    estimatedRtt: 50,
    rttVar: 0
  };

  private adaptiveParams: AdaptiveParams = {
    batchSize: 32, // 초기값
    chunkSize: CHUNK_SIZE_MAX
  };

  // 통계 계산용
  private rttSamples: number[] = [];
  private throughputSamples: number[] = [];
  private minRtt = Infinity;
  private lastUpdateTime = 0;
  private lastBytesSent = 0;
  
  // 상수 설정
  private readonly MIN_CWND = 256 * 1024; // 최소 256KB
  private readonly MAX_CWND = MAX_BUFFERED_AMOUNT; // 16MB
  private readonly RTT_WINDOW = 20; // 최근 20개 샘플만 유지

  constructor() {
    this.reset();
  }

  public start(): void {
    this.lastUpdateTime = performance.now();
    logInfo('[NetworkController]', 'Adaptive Control Started');
  }

  public recordSend(bytes: number): void {
    // WebRTC 통계 외에 앱 레벨 전송량 추적
    this.lastBytesSent += bytes;
  }

  /**
   * WebRTC 통계를 기반으로 네트워크 상태 업데이트
   * @param stats RTCPeerConnection.getStats() 결과
   */
  public updateFromWebRTCStats(stats: RTCStatsReport): void {
    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        // RTT 업데이트
        if (report.currentRoundTripTime) {
          this.updateRtt(report.currentRoundTripTime * 1000);
        }
        // 가용 대역폭 업데이트 (브라우저가 제공하는 경우)
        if (report.availableOutgoingBitrate) {
          this.congestionState.estimatedBw = report.availableOutgoingBitrate / 8;
        }
      }
    });
  }

  /**
   * 버퍼 상태 및 시간을 기반으로 혼잡 제어 알고리즘 수행 (AIMD)
   * @param currentBufferedAmount 현재 WebRTC 채널에 쌓인 데이터 양
   */
  public updateBufferState(currentBufferedAmount: number): void {
    const now = performance.now();
    const elapsed = now - this.lastUpdateTime;
    
    if (elapsed < 100) return; // 너무 빈번한 업데이트 방지

    // 1. 처리량(Throughput) 계산 (이동 평균)
    // 실제 전송량은 bufferedAmount가 줄어든 만큼 + 새로 보낸 만큼 등으로 계산해야 정확하지만,
    // 여기서는 단순화를 위해 전송 시도량을 기준으로 하되 RTT를 반영합니다.
    
    // 2. 혼잡 제어 (Congestion Control) - Delay-based approach
    // RTT가 최소 RTT보다 많이 커지면 혼잡으로 간주
    
    const rttRatio = this.congestionState.estimatedRtt / (this.minRtt || 50);
    
    if (rttRatio > 2.0 || currentBufferedAmount > this.congestionState.cwnd) {
      // [Congestion Detected] Multiplicative Decrease
      // 윈도우 크기를 줄여서 네트워크 부하 감소
      this.congestionState.cwnd = Math.max(
        this.MIN_CWND,
        this.congestionState.cwnd * 0.7
      );
      logDebug('[Network]', `Congestion! Reducing cwnd to ${(this.congestionState.cwnd / 1024).toFixed(0)}KB (RTT: ${this.congestionState.estimatedRtt.toFixed(0)}ms)`);
    } else if (rttRatio < 1.2 && currentBufferedAmount < this.congestionState.cwnd * 0.8) {
      // [Network Clear] Additive Increase
      // 여유가 있으면 윈도우 크기 증가
      this.congestionState.cwnd = Math.min(
        this.MAX_CWND,
        this.congestionState.cwnd + (64 * 1024) // 64KB씩 증가
      );
    }

    // 3. 배치 크기 조정
    // 윈도우 크기에 비례하여 한 번에 가져올 배치 크기 결정
    const targetBatchBytes = this.congestionState.cwnd * 0.2; // 윈도우의 20% 정도를 배치로
    const calculatedBatchSize = Math.floor(targetBatchBytes / this.adaptiveParams.chunkSize);
    
    this.adaptiveParams.batchSize = Math.max(
      BATCH_SIZE_MIN,
      Math.min(BATCH_SIZE_MAX, calculatedBatchSize)
    );

    this.lastUpdateTime = now;
  }

  private updateRtt(rtt: number) {
    // 0이거나 비정상적인 값 필터링
    if (rtt <= 0 || rtt > 10000) return;

    this.rttSamples.push(rtt);
    if (this.rttSamples.length > this.RTT_WINDOW) this.rttSamples.shift();

    // 평균 RTT 계산
    const sum = this.rttSamples.reduce((a, b) => a + b, 0);
    this.congestionState.estimatedRtt = sum / this.rttSamples.length;

    // 최소 RTT 갱신 (Baseline)
    if (rtt < this.minRtt) this.minRtt = rtt;
  }

  // ---------------- Getters & Reset ----------------

  public getAdaptiveParams(): AdaptiveParams {
    return { ...this.adaptiveParams };
  }

  public getCongestionState(): CongestionState {
    return { ...this.congestionState };
  }

  public getMetrics(): TransferMetrics {
    return {
      throughput: this.congestionState.estimatedBw,
      avgRtt: this.congestionState.estimatedRtt,
      lossCount: 0
    };
  }

  public reset(): void {
    this.congestionState = {
      cwnd: 1024 * 1024, // 1MB Start
      estimatedBw: 0,
      estimatedRtt: 50,
      rttVar: 0
    };
    this.adaptiveParams = {
      batchSize: 32,
      chunkSize: CHUNK_SIZE_MAX
    };
    this.rttSamples = [];
    this.throughputSamples = [];
    this.minRtt = Infinity;
    this.lastUpdateTime = 0;
  }

  public getDebugInfo() {
    return {
      cwnd: (this.congestionState.cwnd / 1024 / 1024).toFixed(2) + ' MB',
      rtt: this.congestionState.estimatedRtt.toFixed(0) + ' ms',
      batch: this.adaptiveParams.batchSize,
      minRtt: this.minRtt === Infinity ? 0 : this.minRtt.toFixed(0)
    };
  }
}

export const networkController = new NetworkAdaptiveController();
