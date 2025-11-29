/**
 * MinHeap Priority Queue
 * 오프셋(offset) 기준으로 청크를 항상 정렬된 상태로 유지합니다.
 * 삽입: O(log N), 추출: O(log N), 최솟값 확인: O(1)
 */
export class PriorityQueue<T> {
  private heap: T[] = [];
  private comparator: (a: T, b: T) => number;

  constructor(comparator: (a: T, b: T) => number) {
    this.comparator = comparator;
  }

  public push(item: T): void {
    this.heap.push(item);
    this.siftUp();
  }

  public pop(): T | undefined {
    if (this.isEmpty()) return undefined;
    const top = this.heap[0];
    const bottom = this.heap.pop();
    if (this.heap.length > 0 && bottom !== undefined) {
      this.heap[0] = bottom;
      this.siftDown();
    }
    return top;
  }

  public peek(): T | undefined {
    return this.heap[0];
  }

  public size(): number {
    return this.heap.length;
  }

  public isEmpty(): boolean {
    return this.heap.length === 0;
  }

  public clear(): void {
    this.heap = [];
  }

  private siftUp(): void {
    let node = this.heap.length - 1;
    while (node > 0) {
      const parent = (node - 1) >>> 1;
      if (this.comparator(this.heap[node], this.heap[parent]) < 0) {
        this.swap(node, parent);
        node = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(): void {
    let node = 0;
    while ((node * 2) + 1 < this.heap.length) {
      let left = (node * 2) + 1;
      let right = left + 1;
      let smaller = left;

      if (right < this.heap.length && this.comparator(this.heap[right], this.heap[left]) < 0) {
        smaller = right;
      }

      if (this.comparator(this.heap[smaller], this.heap[node]) < 0) {
        this.swap(node, smaller);
        node = smaller;
      } else {
        break;
      }
    }
  }

  private swap(a: number, b: number): void {
    const temp = this.heap[a];
    this.heap[a] = this.heap[b];
    this.heap[b] = temp;
  }
}