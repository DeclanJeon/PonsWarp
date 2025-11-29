/**
 * 🚀 [Step 12] Simple Transfer Metrics
 * 복잡한 혼잡 제어 로직을 제거하고, 순수하게 전송 속도와 통계만 측정합니다.
 * 실제 흐름 제어는 WebRTC DataChannel의 Backpressure에 맡깁니다.
 */

export interface TransferMetrics {
  bytesSent: number;
  totalBytes: number;
  speed: number;        // bytes per second
  averageSpeed: number; // bytes per second
  progress: number;     // 0-100
  elapsedTime: number;  // seconds
  remainingTime: number;// seconds
}

export class NetworkAdaptiveController {
  private startTime = 0;
  private lastUpdateTime = 0;
  private lastBytesSent = 0;
  private totalBytes = 0;
  private totalBytesSent = 0;
  
  // 이동 평균 속도 계산용 (부드러운 UI 표시)
  private speedSamples: number[] = [];
  private readonly SAMPLE_SIZE = 10;

  constructor() {
    this.reset();
  }

  public start(totalBytes: number): void {
    this.startTime = Date.now();
    this.lastUpdateTime = this.startTime;
    this.totalBytes = totalBytes;
    this.totalBytesSent = 0;
    this.speedSamples = [];
  }

  public recordSend(bytes: number): void {
    this.totalBytesSent += bytes;
  }

  /**
   * 주기적으로 호출되어 현재 속도와 진행률을 계산합니다.
   * (UI 업데이트 루프에서 호출 권장)
   */
  public getMetrics(): TransferMetrics {
    const now = Date.now();
    const elapsedSinceLast = (now - this.lastUpdateTime) / 1000; // seconds

    let currentSpeed = 0;

    // 200ms 이상 지났을 때만 속도 갱신 (너무 잦은 갱신 방지)
    if (elapsedSinceLast >= 0.2) {
      const bytesDiff = this.totalBytesSent - this.lastBytesSent;
      currentSpeed = bytesDiff / elapsedSinceLast;

      // 이동 평균 필터 적용
      this.speedSamples.push(currentSpeed);
      if (this.speedSamples.length > this.SAMPLE_SIZE) {
        this.speedSamples.shift();
      }

      this.lastBytesSent = this.totalBytesSent;
      this.lastUpdateTime = now;
    } else {
      // 갱신 주기 전에는 마지막 계산된 평균 속도 유지
      currentSpeed = this.getAverageSpeed();
    }

    const avgSpeed = this.getAverageSpeed();
    const totalElapsed = (now - this.startTime) / 1000;
    const remainingBytes = Math.max(0, this.totalBytes - this.totalBytesSent);
    const remainingTime = avgSpeed > 0 ? remainingBytes / avgSpeed : 0;

    return {
      bytesSent: this.totalBytesSent,
      totalBytes: this.totalBytes,
      speed: avgSpeed, // UI에는 부드러운 평균값 표시
      averageSpeed: avgSpeed,
      progress: this.totalBytes > 0 ? (this.totalBytesSent / this.totalBytes) * 100 : 0,
      elapsedTime: totalElapsed,
      remainingTime
    };
  }

  private getAverageSpeed(): number {
    if (this.speedSamples.length === 0) return 0;
    const sum = this.speedSamples.reduce((a, b) => a + b, 0);
    return sum / this.speedSamples.length;
  }

  // 기존 코드와의 호환성을 위한 Stub 메서드들 (빈 껍데기)
  public updateBufferState(bufferedAmount: number): void {}
  public updateFromWebRTCStats(stats: any): void {}
  
  // 항상 고정된 최대 배치 설정 반환
  public getAdaptiveParams() {
    return {
      chunkSize: 64 * 1024, // 64KB (고정)
      batchSize: 128,       // 128개 (약 8MB) - 항상 최대 성능
      bufferTarget: 16 * 1024 * 1024 // 16MB
    };
  }

  public reset(): void {
    this.startTime = 0;
    this.lastUpdateTime = 0;
    this.lastBytesSent = 0;
    this.totalBytesSent = 0;
    this.totalBytes = 0;
    this.speedSamples = [];
  }
}

export const networkController = new NetworkAdaptiveController();
