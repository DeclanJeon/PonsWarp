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

import { logWarn } from '../utils/logger';

interface BufferedChunk {
  data: ArrayBuffer;
  timestamp: number;
}

export class ReorderingBuffer {
  private buffer: Map<number, BufferedChunk> = new Map();
  private nextExpectedOffset: number = 0;
  private totalProcessedBytes: number = 0;

  // 🚀 [최적화] 메모리 보호 설정
  private readonly MAX_BUFFER_SIZE = 128 * 1024 * 1024; // 128MB로 상향 (안전마진 확보)
  private readonly CHUNK_TTL = 30000; // 30초로 조정 (메모리 보호 강화)
  private currentBufferSize: number = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(startOffset: number = 0) {
    this.nextExpectedOffset = startOffset;

    // 5초마다 상태 점검 (삭제가 아닌 점검)
    this.cleanupInterval = setInterval(() => this.checkStaleChunks(), 5000);
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

      // 🚀 [개선] 버퍼 오버플로우 시 오래된 청크부터 정리
      if (this.currentBufferSize + chunkLen > this.MAX_BUFFER_SIZE) {
        // 가장 오래된 청크들부터 정리하여 공간 확보
        const sortedEntries = Array.from(this.buffer.entries()).sort(
          (a, b) => a[1].timestamp - b[1].timestamp
        );

        let freedSpace = 0;
        const toDelete: number[] = [];

        for (const [offset, chunk] of sortedEntries) {
          toDelete.push(offset);
          freedSpace += chunk.data.byteLength;
          if (
            this.currentBufferSize + chunkLen - freedSpace <=
            this.MAX_BUFFER_SIZE * 0.8
          ) {
            break; // 80% 수준까지 정리
          }
        }

        toDelete.forEach(offset => {
          const chunk = this.buffer.get(offset)!;
          this.currentBufferSize -= chunk.data.byteLength;
          this.buffer.delete(offset);
        });

        logWarn(
          '[Reorder]',
          `🗑️ Buffer overflow: cleaned ${toDelete.length} oldest chunks (${formatBytes(freedSpace)}) to make space`
        );
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
   * 🚀 [수정] 오래된 청크 청소 로직 개선
   * 메모리 보호를 위해 오래된 청크는 정리하지만, 로그를 상세히 남겨 디버깅 용이
   */
  private checkStaleChunks() {
    const now = Date.now();
    let staleCount = 0;
    const staleOffsets: number[] = [];

    for (const [offset, chunk] of this.buffer.entries()) {
      if (now - chunk.timestamp > this.CHUNK_TTL) {
        staleCount++;
        staleOffsets.push(offset);

        // 🚀 [개선] 메모리 보호를 위해 오래된 청크는 정리
        this.currentBufferSize -= chunk.data.byteLength;
        this.buffer.delete(offset);
      }
    }

    if (staleCount > 0) {
      logWarn(
        '[Reorder]',
        `🗑️ Cleaned ${staleCount} stale chunks (> ${this.CHUNK_TTL}ms). Missing offsets: ${staleOffsets.slice(0, 5).join(', ')}${staleOffsets.length > 5 ? '...' : ''}. Expected: ${this.nextExpectedOffset}`
      );
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
      totalProcessed: this.totalProcessedBytes,
    };
  }

  /**
   * 다음 예상 오프셋 조회
   */
  public getNextExpectedOffset(): number {
    return this.nextExpectedOffset;
  }

  /** Speed sequential path: advance frontier without map push. */
  public advanceTo(nextOffset: number): void {
    if (nextOffset > this.nextExpectedOffset) {
      this.totalProcessedBytes += nextOffset - this.nextExpectedOffset;
      this.nextExpectedOffset = nextOffset;
    }
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

// 헬퍼 함수 (클래스 외부)
function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
