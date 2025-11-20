/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

interface SenderState {
  files: File[];
  manifest: any;
  currentFileIndex: number;
  currentFileOffset: number;
  totalBytesSent: number;
  startTime: number;
  chunkSize: number;
  // 🚀 [추가] 동적 사이징 설정
  minChunkSize: number;
  maxChunkSize: number;
}

(() => {
  class SenderWorker {
    private state: SenderState | null = null;
    
    // 🚨 [추가] 청크 시퀀스 추적
    private chunkSequence: number = 0;

    constructor() {
      self.onmessage = this.handleMessage.bind(this);
      self.postMessage({ type: 'ready' });
    }

    private handleMessage(e: MessageEvent) {
      const { type, payload } = e.data;

      switch (type) {
        case 'init':
          // payload.config가 있으면 사용
          this.init(payload.files, payload.manifest, payload.config);
          break;
        case 'start':
          // 첫 청크 전송 (Pump Priming)
          this.readNextChunk();
          break;
        case 'pull':
          // 메인 스레드가 "더 줘!" 할 때만 읽음
          this.readNextChunk();
          break;
        // 🚀 [핵심] 네트워크 상태 피드백 수신
        case 'network-update':
          this.adjustChunkSize(payload.bufferedAmount, payload.maxBufferedAmount);
          break;
      }
    }

    private init(files: File[], manifest: any, config?: any) {
      const startSize = config?.startChunkSize || 16 * 1024;
      const maxSize = config?.maxChunkSize || 64 * 1024;

      this.state = {
        files: files,
        manifest: manifest,
        currentFileIndex: 0,
        currentFileOffset: 0,
        totalBytesSent: 0,
        startTime: Date.now(),
        chunkSize: startSize,
        minChunkSize: 16 * 1024,
        maxChunkSize: maxSize // 🚨 안전한 최대값 적용 (64KB)
      };
      console.log(`[Worker] Init: ChunkSize=${startSize}, Max=${maxSize}`);
    }

    // 🚀 [최적화] 동적 청크 크기 조절 (AIMD 변형)
    private adjustChunkSize(bufferedAmount: number, maxBufferedAmount: number) {
      if (!this.state) return;

      const usage = bufferedAmount / maxBufferedAmount;

      // 버퍼가 2MB로 늘었으므로, 더 공격적으로 청크를 키워도 됨
      if (usage < 0.1) {
        // 버퍼가 거의 비어있음 -> 크기 증가
        const newSize = Math.floor(this.state.chunkSize * 1.5); // 1.2 -> 1.5배로 가속
        this.state.chunkSize = Math.min(newSize, this.state.maxChunkSize);
      }
      else if (usage > 0.75) {
        // 🚨 기준 완화: 0.5 -> 0.75 (75% 찰 때까지는 속도 유지)
        // 버퍼가 꽉 차감 -> 크기 감소
        const newSize = Math.floor(this.state.chunkSize * 0.8);
        this.state.chunkSize = Math.max(newSize, this.state.minChunkSize);
      }
    }

    private async readNextChunk() {
      if (!this.state) return;

      // 모든 파일 전송 완료 체크
      if (this.state.currentFileIndex >= this.state.files.length) {
        console.log('[SenderWorker] All files processed, sending complete signal');
        self.postMessage({ type: 'complete' });
        return;
      }

      const currentFile = this.state.files[this.state.currentFileIndex];
      
      // 현재 파일 다 읽었으면 다음 파일로
      if (this.state.currentFileOffset >= currentFile.size) {
        console.log(`[SenderWorker] File ${this.state.currentFileIndex} completed, moving to next file`);
        this.state.currentFileIndex++;
        this.state.currentFileOffset = 0;
        // 재귀 호출로 다음 파일 즉시 시작
        this.readNextChunk();
        return;
      }

      // 🚨 [핵심] 동적으로 계산된 chunkSize가 설정된 maxChunkSize를 절대 넘지 않도록 보장
      let targetSize = Math.min(this.state.chunkSize, this.state.maxChunkSize);
      
      const remainingBytes = currentFile.size - this.state.currentFileOffset;
      const actualChunkSize = Math.min(targetSize, remainingBytes);
      
      // 청크 읽기
      const start = this.state.currentFileOffset;
      const end = start + actualChunkSize;
      const blob = currentFile.slice(start, end);
      const arrayBuffer = await blob.arrayBuffer();

      // 🚨 [수정] 유효성 검증
      if (arrayBuffer.byteLength === 0) {
        console.warn('[SenderWorker] Empty chunk detected, skipping');
        // 빈 청크는 건너뛰고 다음 청크 시도
        this.state.currentFileOffset += actualChunkSize;
        this.readNextChunk();
        return;
      }

      // � 헤더 생성 (중요!)
      // Format: [FileIndex(2)][ChunkSize(4)] + Payload
      // 수신측에서 어떤 파일의 데이터인지 알기 위함
      const headerSize = 6;
      const packet = new ArrayBuffer(headerSize + arrayBuffer.byteLength);
      const view = new DataView(packet);
      
      view.setUint16(0, this.state.currentFileIndex, true); // File Index
      view.setUint32(2, arrayBuffer.byteLength, true);      // Payload Size
      
      new Uint8Array(packet, headerSize).set(new Uint8Array(arrayBuffer));

      // 상태 업데이트
      this.state.currentFileOffset += arrayBuffer.byteLength;
      this.state.totalBytesSent += arrayBuffer.byteLength;

      // 🚨 [추가] 청크 시퀀스 추적
      if (!this.chunkSequence) {
        this.chunkSequence = 0;
      }
      this.chunkSequence++;

      // 진행률 데이터 계산
      const elapsed = (Date.now() - this.state.startTime) / 1000;
      const speed = elapsed > 0 ? this.state.totalBytesSent / elapsed : 0;
      // 🚨 [수정] totalSize가 0인 경우를 방지
      const progress = this.state.manifest.totalSize > 0
        ? (this.state.totalBytesSent / this.state.manifest.totalSize) * 100
        : 0;


      // 메인 스레드로 전송 (Transferable)
      self.postMessage({
        type: 'chunk-ready',
        payload: {
          chunk: packet,
          progressData: {
            bytesTransferred: this.state.totalBytesSent,
            totalBytes: this.state.manifest.totalSize,
            speed,
            progress,
            currentFileIndex: this.state.currentFileIndex,
            chunkSequence: this.chunkSequence,
            // 🚀 [추가] 디버깅용: 현재 청크 크기도 UI에 표시
            currentChunkSize: actualChunkSize
          }
        }
      }, [packet]); // Zero-copy transfer
    }
  }

  new SenderWorker();
})();