import { PriorityQueue } from '../utils/priorityQueue';
import { logWarn, logError, logDebug } from '../utils/logger';

interface BufferedChunk {
  data: ArrayBuffer;
  offset: number;
  timestamp: number;
  size: number;
}

// NACK 요청 타입
export interface NackRequest {
  offset: number;     // 예상되는 시작 오프셋
  missingCount: number; // 누락된 것으로 추정되는 청크 수 (추정치)
}

/**
 * 🚀 High-Performance Reordering Buffer (Unordered Mode 대응)
 * 순서가 뒤섞여 들어오는 패킷들을 메모리에서 재조립합니다.
 */
export class ReorderingBuffer {
  private chunkMap: Map<number, BufferedChunk> = new Map();
  
  private nextExpectedOffset: number = 0;
  private totalProcessedBytes: number = 0;
  private currentBufferSize: number = 0;
  
  // 🚀 [최적화] Unordered Mode를 위해 버퍼 사이즈 증대
  // 갭이 발생하면 그 사이의 데이터를 모두 들고 있어야 하므로 넉넉해야 함
  private readonly MAX_BUFFER_SIZE = 128 * 1024 * 1024; // 128MB (기존 64MB에서 2배 증대)
  private readonly CHUNK_TTL = 60000; // 60초 (네트워크 지연 고려하여 연장)
  private cleanupInterval: NodeJS.Timeout | null = null;

  // 🚀 NACK 제어 변수
  private nackCallback: ((nack: NackRequest) => void) | null = null;
  private nackTimer: NodeJS.Timeout | null = null;
  private readonly INITIAL_NACK_DELAY = 100; // 초기 대기 100ms
  private isNackPending = false;
  private nackRetryCount = 0; // 💡 재시도 횟수 추적

  // 디버깅 통계
  private maxGapDetected = 0;
  private outOfOrderCount = 0;

  constructor(startOffset: number = 0) {
    this.nextExpectedOffset = startOffset;
    this.cleanupInterval = setInterval(() => this.cleanupStaleChunks(), 5000);
  }

  // 외부에서 NACK 핸들러 등록
  public onNack(callback: (nack: NackRequest) => void) {
    this.nackCallback = callback;
  }

  /**
   * 청크를 버퍼에 추가하고, 순서가 맞는 연속된 청크들을 배출합니다.
   */
  public push(chunk: ArrayBuffer, offset: number): ArrayBuffer[] {
    const chunkLen = chunk.byteLength;
    const orderedChunks: ArrayBuffer[] = [];

    // 1. 이미 처리된 패킷 (중복 도착) -> 무시
    if (offset < this.nextExpectedOffset) {
      // logDebug('[Reorder]', `Duplicate packet ignored. Offset: ${offset}`);
      return [];
    }

    // 2. 버퍼 용량 초과 체크 (Flow Control)
    // 갭이 너무 커서 버퍼가 꽉 찬 경우
    if (this.currentBufferSize + chunkLen > this.MAX_BUFFER_SIZE) {
      // 🚨 심각: 버퍼 오버플로우.
      // 실제로는 여기서 Drop하면 안되고 Sender를 멈춰야 하지만(Backpressure),
      // 일단 보호를 위해 가장 오래된(Offset이 가장 큰) 청크를 Drop 하거나 현재 청크를 Drop.
      logError('[Reorder]', `Buffer overflow! Dropping chunk ${offset}. Buffer usage: ${(this.currentBufferSize/1024/1024).toFixed(2)}MB`);
      return [];
    }

    // 3. Fast Path: 정확히 기다리던 순서 (갭이 채워짐)
    if (offset === this.nextExpectedOffset) {
      orderedChunks.push(chunk);
      this.advanceOffset(chunkLen);
      this.drainMap(orderedChunks);
      
      // 구멍이 메워졌으므로 NACK 예약 취소
      if (this.isNackPending && !this.chunkMap.has(this.nextExpectedOffset)) {
         this.clearNackTimer();
      }
    } else {
      // 4. 순서가 아님 (Out-of-Order) -> 버퍼링
      if (!this.chunkMap.has(offset)) {
        this.chunkMap.set(offset, {
          data: chunk,
          offset,
          timestamp: Date.now(),
          size: chunkLen
        });
        this.currentBufferSize += chunkLen;
        this.outOfOrderCount++;
        
        // 🚀 [신규] Gap이 처음 감지되면 NACK 타이머 시작
        if (!this.isNackPending && offset > this.nextExpectedOffset) {
            this.scheduleNack();
        }
        
        const gap = offset - this.nextExpectedOffset;
        if (gap > this.maxGapDetected) {
          this.maxGapDetected = gap;
          // 갭이 클 때만 로그 출력 (노이즈 감소)
          if (gap > 10 * 1024 * 1024) {
             logDebug('[Reorder]', `Huge Gap detected: ${(gap/1024/1024).toFixed(2)}MB`);
          }
        }
      }
    }

    return orderedChunks;
  }

  /**
   * Map에서 연속된 청크를 찾아 배출
   */
  private drainMap(outputList: ArrayBuffer[]): void {
    let drainedCount = 0;
    
    // Map에서 nextExpectedOffset에 해당하는 청크가 있는지 확인
    while (this.chunkMap.has(this.nextExpectedOffset)) {
      const chunkObj = this.chunkMap.get(this.nextExpectedOffset)!;
      
      outputList.push(chunkObj.data);
      
      this.chunkMap.delete(this.nextExpectedOffset);
      this.currentBufferSize -= chunkObj.size;
      this.advanceOffset(chunkObj.size);
      drainedCount++;
    }
    
    if (drainedCount > 10) {
      // 한 번에 많은 패킷이 풀렸다면 HOL Blocking이 해소된 것임
      // logDebug('[Reorder]', `🚀 Burst drain: ${drainedCount} chunks reassembled instantly`);
    }
  }

  // 🚀 [수정] 지수 백오프가 적용된 NACK 스케줄링
  private scheduleNack() {
    if (this.nackTimer) clearTimeout(this.nackTimer);
    this.isNackPending = true;
    
    // 재시도 횟수에 따라 대기 시간 증가 (1.5배씩 증가)
    // 1회차: 100ms, 2회차: 150ms, 3회차: 225ms ... 최대 1초
    const delay = Math.min(1000, this.INITIAL_NACK_DELAY * Math.pow(1.5, this.nackRetryCount));
    
    this.nackTimer = setTimeout(() => {
        // 타이머가 터졌는데 여전히 다음 오프셋이 비어있다면 NACK 전송
        if (!this.chunkMap.has(this.nextExpectedOffset)) {
            
            // 너무 많이 시도했으면 포기하거나 로그 레벨을 낮춤
            if (this.nackRetryCount > 20) {
               logError('[Reorder]', `Critical: Offset ${this.nextExpectedOffset} missing after 20 retries.`);
               // 여기서 멈추지 않고 계속 시도하거나, 치명적 에러로 처리
            }

            logWarn('[Reorder]', `Gap at ${this.nextExpectedOffset} (Retry: ${this.nackRetryCount + 1}, Delay: ${delay.toFixed(0)}ms). Requesting retransmission.`);
            
            this.nackCallback?.({
                offset: this.nextExpectedOffset,
                missingCount: 1
            });
            
            this.nackRetryCount++; // 카운트 증가
            this.scheduleNack();   // 다음 타이머 예약
        } else {
            this.isNackPending = false;
        }
    }, delay);
  }

  // 🚀 [신규] 즉시 NACK 전송 (긴급 상황용)
  public sendImmediateNack(offset: number) {
    if (this.nackCallback) {
      logWarn('[Reorder]', `Immediate NACK sent for offset: ${offset}`);
      this.nackCallback({
        offset,
        missingCount: 1
      });
    }
  }

  private clearNackTimer() {
      if (this.nackTimer) {
          clearTimeout(this.nackTimer);
          this.nackTimer = null;
      }
      this.isNackPending = false;
      this.nackRetryCount = 0; // 💡 성공 시 카운트 리셋
  }

  private advanceOffset(len: number) {
    this.nextExpectedOffset += len;
    this.totalProcessedBytes += len;
  }

  /**
   * 오래된 청크 청소
   */
  private cleanupStaleChunks() {
    const now = Date.now();
    // Map은 삽입 순서대로 순회하므로, 타임스탬프 체크에 효율적이지 않을 수 있음.
    // 하지만 전체 스캔은 5초마다 한 번이라 부담 적음.
    for (const [offset, chunk] of this.chunkMap) {
      if (now - chunk.timestamp > this.CHUNK_TTL) {
        logWarn('[Reorder]', `Dropping stale chunk at offset ${offset} (TTL expired)`);
        this.currentBufferSize -= chunk.size;
        this.chunkMap.delete(offset);
      }
    }
  }

  public getStatus() {
    return {
      bufferedCount: this.chunkMap.size,
      bufferedBytes: this.currentBufferSize,
      nextExpected: this.nextExpectedOffset,
      maxGap: this.maxGapDetected,
      outOfOrderCount: this.outOfOrderCount
    };
  }

  /**
   * 🚨 버퍼에 남은 모든 청크를 강제로 배출 (순서 무시)
   * finalize 시점에 호출하여 데이터 손실 방지
   */
  public forceFlushAll(): ArrayBuffer[] {
    const remainingChunks: ArrayBuffer[] = [];
    if (this.chunkMap.size === 0) return remainingChunks;

    logWarn('[Reorder]', `Force flushing ${this.chunkMap.size} chunks. Final gap check.`);
    const sortedOffsets = Array.from(this.chunkMap.keys()).sort((a, b) => a - b);
    
    for (const offset of sortedOffsets) {
      const chunk = this.chunkMap.get(offset)!;
      remainingChunks.push(chunk.data);
    }
    
    this.clear();
    return remainingChunks;
  }

  /**
   * 다음 예상 오프셋 조회
   */
  public getNextExpectedOffset(): number {
    return this.nextExpectedOffset;
  }

  /**
   * 버퍼에 남은 청크 수 조회
   */
  public getPendingCount(): number {
    return this.chunkMap.size;
  }

  public clear(): void {
    this.clearNackTimer(); // 타이머 정리 추가
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.chunkMap.clear();
    this.currentBufferSize = 0;
    this.nextExpectedOffset = 0;
    this.outOfOrderCount = 0;
  }

  /**
   * 리소스 정리 (cleanup 별칭)
   */
  public cleanup(): void {
    this.clear();
  }
}
