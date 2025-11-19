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
}

(() => {
  class SenderWorker {
    private state: SenderState | null = null;
    private readonly DEFAULT_CHUNK_SIZE = 64 * 1024; // 64KB

    constructor() {
      self.onmessage = this.handleMessage.bind(this);
      self.postMessage({ type: 'ready' });
    }

    private handleMessage(e: MessageEvent) {
      const { type, payload } = e.data;

      switch (type) {
        case 'init':
          this.init(payload.files, payload.manifest);
          break;
        case 'start':
          // 첫 청크 전송 (Pump Priming)
          this.readNextChunk();
          break;
        case 'pull':
          // 메인 스레드가 "더 줘!" 할 때만 읽음
          this.readNextChunk();
          break;
      }
    }

    private init(files: File[], manifest: any) {
      this.state = {
        files: files,
        manifest: manifest,
        currentFileIndex: 0,
        currentFileOffset: 0,
        totalBytesSent: 0,
        startTime: Date.now(),
        chunkSize: this.DEFAULT_CHUNK_SIZE
      };
      console.log('[Worker] Initialized with', files.length, 'files');
    }

    private async readNextChunk() {
      if (!this.state) return;

      // 모든 파일 전송 완료 체크
      if (this.state.currentFileIndex >= this.state.files.length) {
        self.postMessage({ type: 'complete' });
        return;
      }

      const currentFile = this.state.files[this.state.currentFileIndex];
      
      // 현재 파일 다 읽었으면 다음 파일로
      if (this.state.currentFileOffset >= currentFile.size) {
        this.state.currentFileIndex++;
        this.state.currentFileOffset = 0;
        // 재귀 호출로 다음 파일 즉시 시작
        this.readNextChunk(); 
        return;
      }

      // 청크 읽기
      const start = this.state.currentFileOffset;
      const end = Math.min(start + this.state.chunkSize, currentFile.size);
      const blob = currentFile.slice(start, end);
      const arrayBuffer = await blob.arrayBuffer();

      // 📦 헤더 생성 (중요!)
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

      // 진행률 데이터 계산
      const elapsed = (Date.now() - this.state.startTime) / 1000;
      const speed = elapsed > 0 ? this.state.totalBytesSent / elapsed : 0;
      const progress = (this.state.totalBytesSent / this.state.manifest.totalSize) * 100;

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
            currentFileIndex: this.state.currentFileIndex
          }
        }
      }, [packet]);
    }
  }

  new SenderWorker();
})();