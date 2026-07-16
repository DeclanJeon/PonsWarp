import initPonsCore, {
  WasmReorderingBuffer as WasmBuffer,
} from 'pons-core-wasm';
import { ReorderingBuffer } from './reorderingBuffer';
import { logDebug, logWarn, logError } from '../utils/logger';

export interface ReorderingBufferStatus {
  bufferedCount: number;
  bufferedBytes: number;
  nextExpected: number;
  totalProcessed: number;
  useWasm: boolean;
}

export class WasmReorderingBuffer {
  private wasmBuffer: WasmBuffer | null = null;
  private fallback: ReorderingBuffer | null = null;
  private useWasm = false;
  private initialized = false;

  /**
   * WASM 모듈 초기화
   * @param startOffset 시작 오프셋 (기본값: 0)
   */
  async initialize(startOffset: number = 0): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await initPonsCore();
      this.wasmBuffer = new WasmBuffer(BigInt(startOffset));
      this.useWasm = true;
      this.initialized = true;
      logDebug('[ReorderingBuffer]', '✅ WASM mode enabled');
    } catch (e) {
      logWarn(
        '[ReorderingBuffer]',
        '⚠️ WASM failed, using JS fallback:',
        e instanceof Error ? e.message : String(e)
      );
      this.fallback = new ReorderingBuffer(startOffset);
      this.useWasm = false;
      this.initialized = true;
    }
  }

  /**
   * 청크 삽입 및 순차 데이터 반환
   * @param chunk 데이터 청크
   * @param offset 청크의 시작 오프셋
   * @returns 순서대로 정렬된 청크 배열 (없으면 빈 배열)
   */
  push(chunk: ArrayBuffer, offset: number): ArrayBuffer[] {
    if (!this.initialized) {
      logError('[ReorderingBuffer]', 'Buffer not initialized');
      return [];
    }

    if (this.useWasm && this.wasmBuffer) {
      try {
        const result = this.wasmBuffer.push(
          new Uint8Array(chunk),
          BigInt(offset)
        );

        if (result) {
          // Uint8Array를 ArrayBuffer로 변환
          return [
            result.buffer.slice(
              result.byteOffset,
              result.byteOffset + result.byteLength
            ) as ArrayBuffer,
          ];
        }
        return [];
      } catch (e) {
        logError('[ReorderingBuffer]', 'WASM push failed:', e);
        // WASM 실패 시 fallback으로 전환
        this.switchToFallback(offset);
        return this.fallback!.push(chunk, offset);
      }
    }

    return this.fallback!.push(chunk, offset);
  }

  /**
   * WASM 실패 시 fallback으로 전환
   */
  private switchToFallback(currentOffset: number): void {
    if (this.fallback) return;

    logWarn('[ReorderingBuffer]', '🔄 Switching to JS fallback');
    this.fallback = new ReorderingBuffer(currentOffset);
    this.useWasm = false;

    // WASM 버퍼 정리
    if (this.wasmBuffer) {
      try {
        this.wasmBuffer.clear();
      } catch {
        // 무시
      }
      this.wasmBuffer = null;
    }
  }

  /**
   * 버퍼 상태 조회
   */
  getStatus(): ReorderingBufferStatus {
    if (this.useWasm && this.wasmBuffer) {
      return {
        bufferedCount: this.wasmBuffer.pending_count,
        bufferedBytes: this.wasmBuffer.buffered_bytes,
        nextExpected: Number(this.wasmBuffer.next_expected_offset),
        totalProcessed: Number(this.wasmBuffer.total_processed),
        useWasm: true,
      };
    }

    if (this.fallback) {
      const status = this.fallback.getStatus();
      return {
        ...status,
        useWasm: false,
      };
    }

    return {
      bufferedCount: 0,
      bufferedBytes: 0,
      nextExpected: 0,
      totalProcessed: 0,
      useWasm: false,
    };
  }

  /**
   * 다음 예상 오프셋 조회
   */
  getNextExpectedOffset(): number {
    if (this.useWasm && this.wasmBuffer) {
      return Number(this.wasmBuffer.next_expected_offset);
    }
    return this.fallback?.getNextExpectedOffset() ?? 0;
  }

  /**
   * Speed sequential path: advance frontier without map push.
   * Uses reset on WASM (no pending out-of-order chunks in sequential mode).
   */
  advanceTo(nextOffset: number): void {
    if (nextOffset <= this.getNextExpectedOffset()) return;
    if (this.useWasm && this.wasmBuffer) {
      try {
        this.wasmBuffer.reset(BigInt(nextOffset));
        return;
      } catch (e) {
        logWarn('[ReorderingBuffer]', 'WASM advanceTo failed, falling back', e);
        this.switchToFallback(nextOffset);
        this.fallback?.advanceTo(nextOffset);
        return;
      }
    }
    this.fallback?.advanceTo(nextOffset);
  }

  /**
   * 버퍼에 남은 청크 수 조회
   */
  getPendingCount(): number {
    if (this.useWasm && this.wasmBuffer) {
      return this.wasmBuffer.pending_count;
    }
    return this.fallback?.getPendingCount() ?? 0;
  }

  /**
   * WASM 사용 여부
   */
  isUsingWasm(): boolean {
    return this.useWasm;
  }

  /**
   * 시작 오프셋 재설정
   */
  reset(startOffset: number = 0): void {
    if (this.useWasm && this.wasmBuffer) {
      this.wasmBuffer.reset(BigInt(startOffset));
    } else if (this.fallback) {
      this.fallback.clear();
      // fallback은 reset이 없으므로 새로 생성
      this.fallback = new ReorderingBuffer(startOffset);
    }
  }

  /**
   * 리소스 정리
   */
  clear(): void {
    if (this.wasmBuffer) {
      try {
        this.wasmBuffer.clear();
      } catch {
        // 무시
      }
    }
    this.fallback?.clear();
  }

  /**
   * 리소스 해제 (cleanup 별칭)
   */
  cleanup(): void {
    this.clear();
    this.wasmBuffer = null;
    this.fallback = null;
    this.initialized = false;
    this.useWasm = false;
  }
}

/**
 * Factory 함수: 초기화된 WasmReorderingBuffer 생성
 */
export async function createWasmReorderingBuffer(
  startOffset: number = 0
): Promise<WasmReorderingBuffer> {
  const buffer = new WasmReorderingBuffer();
  await buffer.initialize(startOffset);
  return buffer;
}
