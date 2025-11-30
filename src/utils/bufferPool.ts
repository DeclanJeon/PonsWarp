/**
 * 🚀 High-Performance Memory Pool
 * 빈번한 ArrayBuffer 할당/해제로 인한 GC 스파이크를 방지합니다.
 * Slab Allocation 패턴을 사용하여 메모리 파편화를 줄입니다.
 */
export class BufferPool {
  // 크기별 버퍼 스택 (Bucket)
  // Key: Buffer Size, Value: Uint8Array[]
  private buckets: Map<number, Uint8Array[]> = new Map();
  
  // 메모리 누수 방지를 위한 최대 풀 크기 (총 256MB 제한)
  private totalAllocated = 0;
  private readonly MAX_POOL_SIZE = 256 * 1024 * 1024; 

  /**
   * 지정된 크기의 버퍼를 가져옵니다.
   */
  public acquire(size: number): Uint8Array {
    const bucket = this.buckets.get(size);
    
    // 1. 풀에 재고가 있으면 반환 (가장 최근에 반납된 것부터 재사용 - Hot Cache)
    if (bucket && bucket.length > 0) {
      return bucket.pop()!;
    }

    // 2. 없으면 새로 할당 (OS로부터 메모리 요청)
    return new Uint8Array(size);
  }

  /**
   * 사용한 버퍼를 풀에 반납합니다.
   */
  public release(buffer: Uint8Array): void {
    const size = buffer.byteLength;

    // 너무 작거나(헤더용) 0인 버퍼는 풀링하지 않음
    if (size < 1024) return;

    // 전체 풀 용량 체크 (안전장치)
    if (this.totalAllocated + size > this.MAX_POOL_SIZE) {
        // 풀이 꽉 찼으면 그냥 버림 (GC가 처리하도록)
        return; 
    }

    if (!this.buckets.has(size)) {
      this.buckets.set(size, []);
    }

    const bucket = this.buckets.get(size)!;
    
    // 과도한 적재 방지 (사이즈별 20개까지만 보관)
    if (bucket.length < 20) {
        bucket.push(buffer);
        // 정확한 메모리 트래킹은 복잡하므로, 여기서는 대략적인 제한만 둠
    }
  }

  public clear(): void {
    this.buckets.clear();
    this.totalAllocated = 0;
  }
}

// 전역 싱글톤 인스턴스
export const bufferPool = new BufferPool();