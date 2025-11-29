import { PriorityQueue } from '../utils/priorityQueue';
import { logWarn, logError, logDebug } from '../utils/logger';

interface BufferedChunk {
  data: ArrayBuffer;
  offset: number;
  timestamp: number;
  size: number;
}

/**
 * 🚀 High-Performance Reordering Buffer
 * * Multi-Channel로 인해 뒤섞여 들어오는 패킷을 순서대로 정렬합니다.
 * - Map: O(1) 접근으로 "다음 순서 패킷"을 즉시 찾음.
 * - PriorityQueue: 버퍼 내부의 가장 오래된(오프셋 기준) 패킷을 추적하여 상태 모니터링.
 */
export class ReorderingBuffer {
  // 빠른 조회를 위한 Map (Offset -> Chunk)
  private chunkMap: Map<number, BufferedChunk> = new Map();
  
  // (선택적) 힙은 복잡한 갭 관리가 필요할 때 사용하지만, 
  // 여기서는 Map의 성능이 압도적이므로 메타데이터 추적용으로만 활용하거나
  // 순수 Map + Offset 추적으로 최적화합니다.
  
  private nextExpectedOffset: number = 0;
  private totalProcessedBytes: number = 0;
  private currentBufferSize: number = 0;
  
  // 🚀 메모리 보호 설정
  private readonly MAX_BUFFER_SIZE = 64 * 1024 * 1024; // 64MB (기존 유지)
  private readonly CHUNK_TTL = 30000; // 30초
  private cleanupInterval: NodeJS.Timeout | null = null;

  // 디버깅용: 갭 통계
  private maxGapDetected = 0;

  constructor(startOffset: number = 0) {
    this.nextExpectedOffset = startOffset;
    
    // 주기적 청소 (메모리 누수 방지)
    this.cleanupInterval = setInterval(() => this.cleanupStaleChunks(), 5000);
  }

  /**
   * 청크를 버퍼에 추가하고, 순서가 맞는 연속된 청크들을 배출합니다.
   */
  public push(chunk: ArrayBuffer, offset: number): ArrayBuffer[] {
    const chunkLen = chunk.byteLength;
    const orderedChunks: ArrayBuffer[] = [];

    // 1. 이미 처리된 패킷 (중복/지연 도착) -> 무시
    if (offset < this.nextExpectedOffset) {
      // logWarn('[Reorder]', `Duplicate or late chunk ignored. Offset: ${offset}, Expected: ${this.nextExpectedOffset}`);
      return [];
    }

    // 2. 버퍼 용량 초과 체크 (Drop Strategy)
    if (this.currentBufferSize + chunkLen > this.MAX_BUFFER_SIZE) {
      logError('[Reorder]', `Buffer overflow! Dropping chunk ${offset}. Buffer: ${(this.currentBufferSize/1024/1024).toFixed(2)}MB`);
      // 🚨 치명적 상황: 여기서 드랍하면 파일이 깨짐. 
      // 실제 프로덕션에선 여기서 "재전송 요청"을 보내야 함.
      // 현재는 보호를 위해 드랍.
      return [];
    }

    // 3. Fast Path: 정확히 기다리던 순서면 바로 배출
    if (offset === this.nextExpectedOffset) {
      orderedChunks.push(chunk);
      this.advanceOffset(chunkLen);
      
      // 4. 연속된 다음 청크들이 버퍼에 있는지 확인 (Drain)
      this.drainMap(orderedChunks);
    } else {
      // 5. 순서가 아니면 버퍼링 (Out-of-Order)
      if (!this.chunkMap.has(offset)) {
        this.chunkMap.set(offset, {
          data: chunk,
          offset,
          timestamp: Date.now(),
          size: chunkLen
        });
        this.currentBufferSize += chunkLen;
        
        // 갭 크기 모니터링 (디버깅)
        const gap = offset - this.nextExpectedOffset;
        if (gap > this.maxGapDetected) {
          this.maxGapDetected = gap;
          // logDebug('[Reorder]', `New Max Gap: ${gap} bytes`);
        }
      }
    }

    return orderedChunks;
  }

  /**
   * Map에서 연속된 청크를 찾아 배출
   */
  private drainMap(outputList: ArrayBuffer[]): void {
    while (this.chunkMap.has(this.nextExpectedOffset)) {
      const chunkObj = this.chunkMap.get(this.nextExpectedOffset)!;
      
      outputList.push(chunkObj.data);
      
      this.chunkMap.delete(this.nextExpectedOffset);
      this.currentBufferSize -= chunkObj.size;
      this.advanceOffset(chunkObj.size);
    }
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
      processedBytes: this.totalProcessedBytes,
      maxGap: this.maxGapDetected
    };
  }

  /**
   * 🚨 버퍼에 남은 모든 청크를 강제로 배출 (순서 무시)
   * finalize 시점에 호출하여 데이터 손실 방지
   */
  public forceFlushAll(): ArrayBuffer[] {
    const remainingChunks: ArrayBuffer[] = [];
    
    if (this.chunkMap.size === 0) {
      return remainingChunks;
    }

    logWarn('[Reorder]', `Force flushing ${this.chunkMap.size} remaining chunks (순서 무시)`);
    
    // 오프셋 순서대로 정렬하여 배출
    const sortedOffsets = Array.from(this.chunkMap.keys()).sort((a, b) => a - b);
    
    for (const offset of sortedOffsets) {
      const chunk = this.chunkMap.get(offset)!;
      remainingChunks.push(chunk.data);
      logWarn('[Reorder]', `Flushing chunk at offset ${offset}, size: ${chunk.size}`);
    }
    
    // 버퍼 초기화
    this.chunkMap.clear();
    this.currentBufferSize = 0;
    
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
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.chunkMap.clear();
    this.currentBufferSize = 0;
    this.nextExpectedOffset = 0;
    this.totalProcessedBytes = 0;
    this.maxGapDetected = 0;
  }

  /**
   * 리소스 정리 (cleanup 별칭)
   */
  public cleanup(): void {
    this.clear();
  }
}
