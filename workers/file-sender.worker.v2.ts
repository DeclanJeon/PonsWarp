/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// 상수 직접 정의 (워커에서 import 문제 방지용)
const CHUNK_SIZE = 64 * 1024; // 64KB
// 🚨 [수정] const -> let 변경 (초기화 시 메인 스레드에서 값을 받음)
let BATCH_SIZE = 80;        // 한 번에 80개씩 묶어서 전송 (기본값)

(() => {
  class FastSenderWorker {
    private files: File[] = [];
    private manifest: any = null;
    private currentFileIndex = 0;
    private currentFileOffset = 0;
    private chunkSequence = 0;
    private isPaused = false;
    private totalBytesSent = 0;
    private startTime = 0;

    constructor() {
      self.onmessage = this.handleMessage.bind(this);
      self.postMessage({ type: 'ready' });
    }

    private handleMessage(e: MessageEvent) {
      const { type, payload } = e.data;
      console.log('[Sender Worker] Message received:', type, payload);

      switch (type) {
        case 'init':
          this.init(payload.files, payload.manifest, payload.config);
          break;
        case 'start': // 전송 시작 또는 재개(Resume)
          console.log('[Sender Worker] Start command received, isPaused:', this.isPaused, 'startTime:', this.startTime);
          if (this.isPaused || this.startTime === 0) {
            this.isPaused = false;
            if (this.startTime === 0) this.startTime = Date.now();
            console.log('[Sender Worker] Starting batch loop');
            this.sendBatchLoop();
          }
          break;
        case 'pause': // Backpressure에 의한 일시 정지
          console.log('[Sender Worker] Pause command received');
          this.isPaused = true;
          break;
      }
    }

    private init(files: File[], manifest: any, config?: any) {
      console.log('[Sender Worker] Initializing with', files.length, 'files');
      
      // 설정값 적용
      if (config && config.batchSize) {
          BATCH_SIZE = config.batchSize;
          console.log('[Sender Worker] Applied Config - Batch Size:', BATCH_SIZE);
      }

      this.files = files;
      this.manifest = manifest;
      this.currentFileIndex = 0;
      this.currentFileOffset = 0;
      this.chunkSequence = 0;
      this.totalBytesSent = 0;
      this.startTime = 0;
      this.isPaused = true; // start 신호 대기
      console.log('[Sender Worker] Initialization complete, waiting for start signal');
    }

    // 🚀 [핵심] 배치 전송 루프
    private async sendBatchLoop() {
      // 멈춤 상태거나 파일 끝났으면 종료
      if (this.isPaused || this.currentFileIndex >= this.files.length) {
        console.log('[Sender Worker] Batch loop stopping - isPaused:', this.isPaused, 'fileIndex:', this.currentFileIndex, 'totalFiles:', this.files.length);
        return;
      }

      const chunkBatch: ArrayBuffer[] = [];
      const transferables: ArrayBuffer[] = [];
      let batchRawBytes = 0; // 🚨 헤더 제외 순수 데이터 크기 합계

      // 1. 배치 사이즈만큼 청크를 읽어서 모음
      while (chunkBatch.length < BATCH_SIZE && this.currentFileIndex < this.files.length) {
        const chunkData = await this.readNextChunk();
        
        if (chunkData) {
          const packet = this.createPacket(chunkData);
          
          // Zero-Copy: 버퍼의 소유권을 메인 스레드로 이전하기 위해 준비
          chunkBatch.push(packet.buffer);
          transferables.push(packet.buffer);
          
          // 🚨 [수정] 패킷 크기가 아니라 순수 데이터 크기(chunkData.data.byteLength)만 누적
          batchRawBytes += chunkData.data.byteLength;
        } else {
          // 파일 끝 도달, 다음 파일로 이동은 readNextChunk 내부에서 처리됨
          if (this.currentFileIndex >= this.files.length) break;
        }
      }

      // 2. 메인 스레드로 "한 방에" 전송 (postMessage 오버헤드 최소화)
      if (chunkBatch.length > 0) {
        // 🚨 [수정] 순수 데이터 크기만 전달하여 진행률 계산
        const progress = this.calculateProgress(batchRawBytes);
        console.log('[Sender Worker] Sending batch of', chunkBatch.length, 'chunks, raw bytes:', batchRawBytes, 'totalBytesSent:', this.totalBytesSent);
        
        self.postMessage({
          type: 'chunk-batch',
          payload: {
            chunks: chunkBatch,
            progressData: progress
          }
        }, transferables); // 배열 내의 모든 버퍼를 Transferable로 전송
      }

      // 3. 완료 체크
      if (this.currentFileIndex >= this.files.length) {
        console.log('[Sender Worker] All files processed, sending complete message');
        self.postMessage({ type: 'complete' });
        return;
      }

      // 4. 재귀 호출 (Stack Overflow 방지를 위해 setTimeout 0 사용)
      // 🚨 [핵심 수정] Promise.resolve().then() 대신 setTimeout 사용
      // 이를 통해 매크로태스크 큐에 작업을 넣어,
      // 그 사이에 들어온 'pause' 메시지(onmessage)가 처리될 틈을 줍니다.
      if (!this.isPaused) {
         setTimeout(() => this.sendBatchLoop(), 0);
      } else {
         console.log('[Sender Worker] Paused, waiting for resume signal');
      }
    }

    private async readNextChunk() {
      const file = this.files[this.currentFileIndex];
      if (!file) {
        console.log('[Sender Worker] No more files to read');
        return null;
      }

      const start = this.currentFileOffset;
      const end = Math.min(start + CHUNK_SIZE, file.size);

      if (start >= file.size) {
        console.log('[Sender Worker] File', this.currentFileIndex, 'completed, moving to next file');
        this.currentFileIndex++;
        this.currentFileOffset = 0;
        return this.readNextChunk(); // 다음 파일 읽기 재귀 호출
      }

      // 파일 슬라이싱 & 버퍼 읽기
      const blob = file.slice(start, end);
      const buffer = await blob.arrayBuffer();
      
      const fileIndex = this.currentFileIndex;
      const offset = start;
      
      this.currentFileOffset = end;

      return { data: buffer, fileIndex, offset };
    }

    private createPacket(chunkData: { data: ArrayBuffer; fileIndex: number; offset: number }) {
      const { data, fileIndex, offset } = chunkData;
      const seq = this.chunkSequence++;

      // 헤더 생성 (18 Bytes)
      const header = new ArrayBuffer(18);
      const view = new DataView(header);
      view.setUint16(0, fileIndex, true);
      view.setUint32(2, seq, true);
      view.setBigUint64(6, BigInt(offset), true);
      view.setUint32(14, data.byteLength, true);

      // 헤더 + 데이터 병합
      const packet = new Uint8Array(18 + data.byteLength);
      packet.set(new Uint8Array(header), 0);
      packet.set(new Uint8Array(data), 18);

      return packet; // Uint8Array 반환
    }

    private calculateProgress(rawBytes: number) {
      this.totalBytesSent += rawBytes; // 🚨 순수 파일 데이터 누적량만 저장
      
      const elapsed = (Date.now() - this.startTime) / 1000;
      const speed = elapsed > 0 ? this.totalBytesSent / elapsed : 0;
      
      // 🚨 [핵심 수정] 100% 초과 방지 (Floating Point 오차 보정)
      const percentage = Math.min(100, (this.totalBytesSent / this.manifest.totalSize) * 100);

      return {
        bytesTransferred: this.totalBytesSent,
        totalBytes: this.manifest.totalSize,
        speed,
        progress: percentage
      };
    }
  }

  new FastSenderWorker();
})();