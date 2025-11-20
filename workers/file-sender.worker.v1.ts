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
    // 🚀 [최적화 2] 배치 사이즈 상수 (constants와 맞춤)
    private readonly BATCH_SIZE = 5;
    
    // 🚨 [핵심 수정] 중복 실행 방지를 위한 플래그
    private isReading = false;
    // 🚨 [핵심 수정] 작업 중 들어온 요청을 기억하는 카운터
    private pendingPulls = 0;

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
        case 'pull':
          // 🚨 [핵심 수정] 즉시 실행하지 않고 스케줄링 요청
          this.scheduleBatch();
          break;
        // 🚀 [핵심] 네트워크 상태 피드백 수신
        case 'network-update':
          this.adjustChunkSize(payload.bufferedAmount, payload.maxBufferedAmount);
          break;
      }
    }

    private init(files: File[], manifest: any, config?: any) {
      const startSize = config?.startChunkSize || 64 * 1024;
      const maxSize = config?.maxChunkSize || 128 * 1024;

      this.state = {
        files: files,
        manifest: manifest,
        currentFileIndex: 0,
        currentFileOffset: 0,
        totalBytesSent: 0,
        startTime: Date.now(),
        chunkSize: startSize,
        minChunkSize: 16 * 1024,
        maxChunkSize: maxSize // 🚨 안전한 최대값 적용 (128KB)
      };
      
      // 초기화 시 플래그 리셋
      this.isReading = false;
      this.pendingPulls = 0;
      
      console.log(`[Worker] Init: ChunkSize=${startSize}, Max=${maxSize}, Batch=${this.BATCH_SIZE}`);
    }

    // 🚨 [신규] 읽기 작업 스케줄러 (Lock 시스템)
    private async scheduleBatch() {
        // 요청 카운트 증가
        this.pendingPulls++;
        
        // 이미 읽고 있다면 대기 (중복 실행 방지)
        if (this.isReading) return;
        
        this.isReading = true;
        
        // 대기 중인 요청이 없을 때까지 계속 처리
        while (this.pendingPulls > 0) {
            // 요청 하나 소모 (한 번의 pull = 한 번의 batch)
            // *중요: Batch 처리가 너무 빠르면 큐가 쌓일 수 있으므로
            // 여기서 pendingPulls를 0으로 초기화하지 않고 1씩 줄이거나,
            // 혹은 한 번의 루프로 여러 pull을 퉁칠 수도 있음.
            // 여기서는 안전하게 1 감소.
            this.pendingPulls--;
            
            await this.processBatch();
            
            // 파일 전송이 끝났으면 루프 탈출 및 카운터 초기화
            if (this.state && this.state.currentFileIndex >= this.state.files.length) {
                this.pendingPulls = 0;
                break;
            }
        }
        
        this.isReading = false;
    }

    private adjustChunkSize(bufferedAmount: number, maxBufferedAmount: number) {
      if (!this.state) return;
      // 🚀 [최적화 4] 로직 단순화: 버퍼가 여유로우면 Max까지 빠르게 증가
      const usage = bufferedAmount / maxBufferedAmount;

      if (usage < 0.2) {
        // 버퍼 여유 -> 과감하게 증속
        this.state.chunkSize = Math.min(this.state.chunkSize * 2, this.state.maxChunkSize);
      } else if (usage > 0.8) {
        // 버퍼 위험 -> 감속
        this.state.chunkSize = Math.max(this.state.chunkSize * 0.7, this.state.minChunkSize);
      }
    }

    // 🚀 [최적화 2] 배치 처리 루프
    private async processBatch() {
      if (!this.state) return;

      for (let i = 0; i < this.BATCH_SIZE; i++) {
        // 파일 끝 도달 시 루프 중단 및 완료 처리
        if (this.state.currentFileIndex >= this.state.files.length) {
           self.postMessage({ type: 'complete' });
           return;
        }
        
        // 청크 하나 읽고 전송
        const continued = await this.readNextChunk();
        
        // 읽기 중 문제 발생했거나 완료되었으면 중단
        if (!continued) return;
      }
    }

    // 단일 청크 읽기 (성공 여부 반환)
    private async readNextChunk(): Promise<boolean> {
      if (!this.state) return false;

      const currentFile = this.state.files[this.state.currentFileIndex];
      
      if (this.state.currentFileOffset >= currentFile.size) {
        this.state.currentFileIndex++;
        this.state.currentFileOffset = 0;
        // 다음 파일로 넘어갈 때는 재귀 대신 true 반환하여 배치 루프에서 계속 처리
        return true;
      }

      let targetSize = Math.floor(this.state.chunkSize); // 정수 보장
      const remainingBytes = currentFile.size - this.state.currentFileOffset;
      const actualChunkSize = Math.min(targetSize, remainingBytes);
      
      const start = this.state.currentFileOffset;
      const blob = currentFile.slice(start, start + actualChunkSize);
      const arrayBuffer = await blob.arrayBuffer();

      if (arrayBuffer.byteLength === 0) {
        this.state.currentFileOffset += actualChunkSize;
        return true;
      }

      const headerSize = 6;
      const packet = new ArrayBuffer(headerSize + arrayBuffer.byteLength);
      const view = new DataView(packet);
      
      view.setUint16(0, this.state.currentFileIndex, true);
      view.setUint32(2, arrayBuffer.byteLength, true);
      new Uint8Array(packet, headerSize).set(new Uint8Array(arrayBuffer));

      this.state.currentFileOffset += arrayBuffer.byteLength;
      this.state.totalBytesSent += arrayBuffer.byteLength;
      this.chunkSequence++;

      const elapsed = (Date.now() - this.state.startTime) / 1000;
      const speed = elapsed > 0 ? this.state.totalBytesSent / elapsed : 0;
      
      // 🚨 [안전장치] 진행률이 100%를 넘지 않도록 시각적 보정
      let progress = this.state.manifest.totalSize > 0
        ? (this.state.totalBytesSent / this.state.manifest.totalSize) * 100
        : 0;
      if (progress > 100) progress = 100;

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
            chunkSequence: this.chunkSequence
          }
        }
      }, [packet]);

      return true;
    }

  }

  new SenderWorker();
})();