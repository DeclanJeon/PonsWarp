import { BATCH_SIZE_MIN, BATCH_SIZE_MAX, BATCH_SIZE_INITIAL, HIGH_WATER_MARK, LOW_WATER_MARK } from '../utils/constants';

export interface TransferMetrics {
  bytesSent: number;
  totalBytes: number;
  speed: number;        // bytes per second
  averageSpeed: number; // bytes per second
  progress: number;     // 0-100
  elapsedTime: number;  // seconds
  remainingTime: number;// seconds
  currentBatchSize: number; // 🚀 현재 적용 중인 배치 크기 (디버깅용)
}

export class NetworkAdaptiveController {
  private startTime = 0;
  private lastUpdateTime = 0;
  private lastBytesSent = 0;
  private totalBytes = 0;
  private totalBytesSent = 0;
  
  // 🚀 [적응형 제어 변수]
  private currentBatchSize = BATCH_SIZE_INITIAL;
  private congestionWindow = 0; // 현재 비행 중인(In-flight) 데이터 크기 추정
  
  // 속도 측정용 샘플링
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
    this.currentBatchSize = BATCH_SIZE_INITIAL;
    this.speedSamples = [];
  }

  public recordSend(bytes: number): void {
    this.totalBytesSent += bytes;
  }

  /**
   * 🚀 [핵심] WebRTC 버퍼 상태에 따라 배치 크기 조절 (AIMD 알고리즘)
   * drain 이벤트나 주기적인 모니터링 시 호출됨
   */
  public updateBufferState(bufferedAmount: number): void {
    // 1. 혼잡 감지 (Congestion Detected)
    if (bufferedAmount > HIGH_WATER_MARK * 0.8) {
      // 버퍼가 80% 이상 차면 배치를 절반으로 줄임 (Multiplicative Decrease)
      this.currentBatchSize = Math.max(BATCH_SIZE_MIN, Math.floor(this.currentBatchSize * 0.5));
    }
    // 2. 여유 감지 (Idle Detected)
    else if (bufferedAmount < LOW_WATER_MARK) {
      // 버퍼가 여유로우면 배치를 1씩 늘림 (Additive Increase)
      // 너무 급격히 늘어나지 않도록 제한
      if (this.currentBatchSize < BATCH_SIZE_MAX) {
        this.currentBatchSize += 1;
      }
    }
    // 중간 상태에서는 현상 유지
  }

  /**
   * 워커에게 요청할 최적의 배치 크기 반환
   */
  public getRecommendedBatchSize(): number {
    return this.currentBatchSize;
  }

  public getMetrics(): TransferMetrics {
    const now = Date.now();
    const elapsedSinceLast = (now - this.lastUpdateTime) / 1000;

    // 200ms마다 속도 갱신
    if (elapsedSinceLast >= 0.2) {
      const bytesDiff = this.totalBytesSent - this.lastBytesSent;
      const currentSpeed = bytesDiff / elapsedSinceLast;

      this.speedSamples.push(currentSpeed);
      if (this.speedSamples.length > this.SAMPLE_SIZE) {
        this.speedSamples.shift();
      }

      this.lastBytesSent = this.totalBytesSent;
      this.lastUpdateTime = now;
    }

    const avgSpeed = this.getAverageSpeed();
    const totalElapsed = (now - this.startTime) / 1000;
    const remainingBytes = Math.max(0, this.totalBytes - this.totalBytesSent);
    const remainingTime = avgSpeed > 0 ? remainingBytes / avgSpeed : 0;

    return {
      bytesSent: this.totalBytesSent,
      totalBytes: this.totalBytes,
      speed: avgSpeed,
      averageSpeed: avgSpeed,
      progress: this.totalBytes > 0 ? (this.totalBytesSent / this.totalBytes) * 100 : 0,
      elapsedTime: totalElapsed,
      remainingTime,
      currentBatchSize: this.currentBatchSize // 모니터링용
    };
  }

  private getAverageSpeed(): number {
    if (this.speedSamples.length === 0) return 0;
    const sum = this.speedSamples.reduce((a, b) => a + b, 0);
    return sum / this.speedSamples.length;
  }

  public reset(): void {
    this.startTime = 0;
    this.lastUpdateTime = 0;
    this.lastBytesSent = 0;
    this.totalBytesSent = 0;
    this.totalBytes = 0;
    this.currentBatchSize = BATCH_SIZE_INITIAL;
    this.speedSamples = [];
  }
}

export const networkController = new NetworkAdaptiveController();
