/**
 * ReorderingBuffer (Optimized with TTL)
 * 
 * 비순차적으로 도착하는 청크들을 순서대로 정렬하여 내보내는 버퍼.
 * StreamSaver와 같이 순차 쓰기만 지원하는 Writer를 위해 필수적입니다.
 * 
 * Multi-Channel 전송이나 네트워크 지연(Jitter) 상황에서 
 * 패킷이 순서 뒤바뀜(Out-of-Order) 상태로 도착할 경우 파일 손상을 방지합니다.
 * 
 * 🚀 [최적화] TTL(Time-To-Live) 및 자동 정리 기능 추가
 */

import { logDebug, logWarn, logError } from '../utils/logger';

interface BufferedChunk {
  data: ArrayBuffer;
  timestamp: number;
}

export class ReorderingBuffer {
  private buffer: Map<number, BufferedChunk> = new Map();
  private nextExpectedOffset: number = 0;
  private totalProcessedBytes: number = 0;
  
  // 🚀 [최적화] 메모리 보호 설정
  private readonly MAX_BUFFER_SIZE = 64 * 1024 * 1024; // 64MB 제한
  private readonly CHUNK_TTL = 30000; // 30초가 지난 청크는 폐기 (유효기간)
  private currentBufferSize: number = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(startOffset: number = 0) {
    this.nextExpectedOffset = startOffset;
    
    // 5초마다 청소부 실행
    this.cleanupInterval = setInterval(() => this.cleanupStaleChunks(), 5000);
  }

  /**
   * 청크를 추가하고, 순서가 맞는 청크들을 반환합니다.
   * @param chunk 데이터 청크
   * @param offset 청크의 시작 오프셋 (전체 파일 기준)
   * @returns 순서대로 정렬된 청크 배열 (없으면 빈 배열)
   */
  public push(chunk: ArrayBuffer, offset: number): ArrayBuffer[] {
    const chunkLen = chunk.byteLength;
    const orderedChunks: ArrayBuffer[] = [];

    // 1. 이미 처리된 데이터거나 중복인 경우 무시 (Fast Return)
    if (offset < this.nextExpectedOffset) {
      return [];
    }

    // 2. Fast Path: 정확히 기다리던 순서
    if (offset === this.nextExpectedOffset) {
      orderedChunks.push(chunk);
      this.advanceOffset(chunkLen);
      this.drainBuffer(orderedChunks); // 연속된 다음 청크 확인
    } else {
      // 3. Buffered Path: 순서가 아님 -> 버퍼링
      // 🚨 [최적화] 버퍼 오버플로우 방지 (Drop Strategy)
      if (this.currentBufferSize + chunkLen > this.MAX_BUFFER_SIZE) {
        logError('[Reorder]', 'Buffer overflow! Dropping packet to prevent crash.');
        return []; // 치명적이지만 앱 크래시보다는 나음 (재전송 로직 필요)
      }

      if (!this.buffer.has(offset)) {
        this.buffer.set(offset, { data: chunk, timestamp: Date.now() });
        this.currentBufferSize += chunkLen;
      }
    }

    return orderedChunks;
  }

  /**
   * 버퍼에서 연속된 청크를 찾아 배출합니다.
   */
  private drainBuffer(outputList: ArrayBuffer[]): void {
    while (this.buffer.has(this.nextExpectedOffset)) {
      const { data } = this.buffer.get(this.nextExpectedOffset)!;
      const len = data.byteLength;

      outputList.push(data);

      // 버퍼에서 제거 및 상태 업데이트
      this.buffer.delete(this.nextExpectedOffset);
      this.currentBufferSize -= len;
      this.advanceOffset(len);
    }
  }

  private advanceOffset(len: number) {
    this.nextExpectedOffset += len;
    this.totalProcessedBytes += len;
  }

  /**
   * 🚀 [최적화] 오래된 청크 청소 (GC 유도)
   */
  private cleanupStaleChunks() {
    const now = Date.now();
    for (const [offset, chunk] of this.buffer.entries()) {
      if (now - chunk.timestamp > this.CHUNK_TTL) {
        logWarn('[Reorder]', `Dropping stale chunk at offset ${offset}`);
        this.currentBufferSize -= chunk.data.byteLength;
        this.buffer.delete(offset);
      }
    }
  }

  /**
   * 디버그용 상태 조회
   */
  public getStatus() {
    return {
      bufferedCount: this.buffer.size,
      bufferedBytes: this.currentBufferSize,
      nextExpected: this.nextExpectedOffset,
      totalProcessed: this.totalProcessedBytes
    };
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
    return this.buffer.size;
  }

  /**
   * 메모리 정리
   */
  public clear(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.buffer.clear();
    this.currentBufferSize = 0;
    this.nextExpectedOffset = 0;
    this.totalProcessedBytes = 0;
  }

  /**
   * 리소스 정리 (cleanup 별칭)
   */
  public cleanup(): void {
    this.clear();
  }
}
