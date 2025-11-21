/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

interface CongestionState {
  windowSize: number;
  threshold: number;
  inSlowStart: boolean;
  timeout: number;
}

interface PendingChunk {
  sentAt: number;
  data: ArrayBuffer;
}

(() => {
  class EnhancedSenderWorker {
    private files: File[] = [];
    private manifest: any = null;
    private currentFileIndex = 0;
    private currentFileOffset = 0;
    
    private totalBytesSent = 0;
    private startTime = 0;
    private isPaused = false;
    
    // 🚀 [Phase 1] constants 활용
    private currentChunkSize = 64 * 1024; // CHUNK_SIZE_INITIAL
    private readonly CHUNK_SIZE_MIN = 32 * 1024;      // constants.CHUNK_SIZE_MIN
    private readonly CHUNK_SIZE_MAX = 128 * 1024;     // constants.CHUNK_SIZE_MAX
    private readonly RTT_THRESHOLD_LOW = 50;          // constants.RTT_THRESHOLD_LOW
    private readonly RTT_THRESHOLD_HIGH = 150;        // constants.RTT_THRESHOLD_HIGH
    private readonly RTT_SAMPLE_SIZE = 10;            // constants.RTT_SAMPLE_SIZE
    
    private congestion: CongestionState = {
      windowSize: 8,
      threshold: 64,
      inSlowStart: true,
      timeout: 3000
    };

    private pendingChunks = new Map<number, PendingChunk>();
    private chunkSequence = 0;
    private isLoopRunning = false;
    
    // 🚀 [Phase 1] RTT 측정 및 동적 청크 크기 조정
    private rttSamples: number[] = [];
    private averageRTT = 100;

    constructor() {
      self.onmessage = this.handleMessage.bind(this);
      // 🚨 [핵심 수정] Worker 생성 즉시 ready 신호 전송
      self.postMessage({ type: 'ready' });
      // console.log('[SenderWorker] Initialized and ready');
    }

    private handleMessage(e: MessageEvent) {
      const { type, payload } = e.data;

      switch (type) {
        case 'init':
          this.init(payload.files, payload.manifest);
          break;
        case 'start':
          if (!this.isLoopRunning) {
            this.startTime = Date.now();
            this.isPaused = false;
            this.sendLoop();
          }
          break;
        case 'ack-received':
          this.handleAck(payload.seq);
          break;
        case 'network-congestion':
          this.handleNetworkCongestion();
          break;
        case 'pause':
          this.isPaused = true;
          break;
      }
    }

    private init(files: File[], manifest: any) {
      this.files = files;
      this.manifest = manifest;
      this.currentFileIndex = 0;
      this.currentFileOffset = 0;
      this.chunkSequence = 0;
      this.totalBytesSent = 0;
      this.currentChunkSize = 64 * 1024; // CHUNK_SIZE_INITIAL
      this.pendingChunks.clear();
      this.rttSamples = [];
      this.averageRTT = 100;
      
      // console.log(`[Sender] Init: ${files.length} files, ${manifest.totalSize} bytes`);
      // 🚨 [수정] ready를 다시 보내지 않음 - 무한 루프 방지
    }

    private async sendLoop() {
      if (this.isLoopRunning || this.isPaused) return;
      this.isLoopRunning = true;

      try {
        while (
          !this.isPaused && 
          this.pendingChunks.size < this.congestion.windowSize &&
          this.currentFileIndex < this.files.length
        ) {
          const chunkData = await this.readNextChunk();
          
          if (chunkData && chunkData.data) {
            this.sendChunk(chunkData);
          } else {
            if (this.currentFileIndex >= this.files.length) {
              break;
            }
          }
        }
      } catch (err) {
        // console.error('[Sender] Loop Error:', err);
      } finally {
        this.isLoopRunning = false;
        if (this.currentFileIndex >= this.files.length && this.pendingChunks.size === 0) {
          self.postMessage({ type: 'complete' });
        }
      }
    }

    private async readNextChunk(): Promise<{ data: ArrayBuffer; fileIndex: number; offset: number } | null> {
      const file = this.files[this.currentFileIndex];
      if (!file) return null;

      // 🚀 [Phase 1] RTT 기반 동적 청크 크기 조정 (constants 활용)
      if (this.averageRTT < this.RTT_THRESHOLD_LOW) {
        this.currentChunkSize = this.CHUNK_SIZE_MAX; // 고속 네트워크
      } else if (this.averageRTT < this.RTT_THRESHOLD_HIGH) {
        this.currentChunkSize = 64 * 1024; // 일반 네트워크
      } else {
        this.currentChunkSize = this.CHUNK_SIZE_MIN; // 느린 네트워크
      }
      
      // 혼잡 제어에 따른 추가 조정
      if (this.congestion.windowSize < 4) {
        this.currentChunkSize = Math.max(this.CHUNK_SIZE_MIN, this.currentChunkSize / 2);
      }

      const start = this.currentFileOffset;
      const end = Math.min(start + this.currentChunkSize, file.size);
      
      if (start >= file.size) {
        this.currentFileIndex++;
        this.currentFileOffset = 0;
        return this.readNextChunk();
      }
      
      const blob = file.slice(start, end);
      const buffer = await blob.arrayBuffer();
      
      this.currentFileOffset = end;
      
      return {
        data: buffer,
        fileIndex: this.currentFileIndex,
        offset: start
      };
    }

    private sendChunk(chunkData: { data: ArrayBuffer; fileIndex: number; offset: number }) {
      const { data, fileIndex, offset } = chunkData;
      
      const seq = this.chunkSequence++;
      
      // 🚨 [진단] 전송할 청크 정보
      // console.log('[SenderWorker] Preparing chunk:', {
      //   seq,
      //   fileIndex,
      //   offset,
      //   dataSize: data.byteLength,
      //   fileInfo: this.manifest?.files[fileIndex]?.name
      // });
      
      // 헤더: 18 Bytes
      // 0-1: FileIndex (2)
      // 2-5: Sequence (4)
      // 6-13: Offset (8)
      // 14-17: DataLen (4)
      const header = new ArrayBuffer(18);
      const view = new DataView(header);
      
      view.setUint16(0, fileIndex, true);
      view.setUint32(2, seq, true);
      view.setBigUint64(6, BigInt(offset), true);
      view.setUint32(14, data.byteLength, true);

      // 🚨 [진단] 헤더 내용 확인
      const headerBytes = new Uint8Array(header);
      // console.log('[SenderWorker] Header bytes:', Array.from(headerBytes));

      // 패킷 병합 (Header + Data)
      const packet = new Uint8Array(18 + data.byteLength);
      packet.set(new Uint8Array(header), 0);
      packet.set(new Uint8Array(data), 18);

      // 🚨 [진단] 패킷 데이터 확인 (첫 20바이트)
      // console.log('[SenderWorker] Packet data (first 20 bytes):',
      //   Array.from(packet.slice(0, Math.min(20, packet.byteLength))));
      // console.log('[SenderWorker] Packet total size:', packet.byteLength);

      this.pendingChunks.set(seq, {
        sentAt: Date.now(),
        data: data
      });

      const progressData = this.calculateProgress(data.byteLength);
      
      // 🚨 [핵심 수정] Transferable 객체 전송 문제 해결
      // packet.slice()는 Uint8Array를 반환하므로 .buffer를 transferable로 전송
      const packetCopy = packet.slice(); // Uint8Array 복사본
      const transferableBuffer = packetCopy.buffer; // ArrayBuffer 추출
      
      // console.log('[SenderWorker] Sending to main thread:', {
      //   originalSize: packet.buffer.byteLength,
      //   copySize: packetCopy.byteLength,
      //   bufferSize: transferableBuffer.byteLength,
      //   isTransferable: transferableBuffer instanceof ArrayBuffer
      // });
      
      // 복사본의 buffer를 transferable로 전송
      self.postMessage({
        type: 'chunk-ready',
        payload: {
          chunk: transferableBuffer,
          chunkSequence: seq,
          progressData
        }
      }, [transferableBuffer]);

      setTimeout(() => this.checkTimeout(seq), this.congestion.timeout);
      
      this.sendLoop();
    }

    private handleAck(seq: number) {
      if (this.pendingChunks.has(seq)) {
        const pending = this.pendingChunks.get(seq)!;
        
        // 🚀 [Phase 1] RTT 측정
        const rtt = Date.now() - pending.sentAt;
        this.rttSamples.push(rtt);
        
        // 🚀 [Phase 1] constants 활용: RTT 샘플 크기 제한
        if (this.rttSamples.length > this.RTT_SAMPLE_SIZE) {
          this.rttSamples.shift();
        }
        
        // 평균 RTT 계산
        this.averageRTT = Math.round(
          this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length
        );
        
        this.pendingChunks.delete(seq);
        
        // Congestion Control: Window Increase
        if (this.congestion.inSlowStart) {
          this.congestion.windowSize += 1;
          if (this.congestion.windowSize >= this.congestion.threshold) {
            this.congestion.inSlowStart = false;
          }
        } else {
          this.congestion.windowSize += 1 / this.congestion.windowSize;
        }
        this.congestion.windowSize = Math.min(this.congestion.windowSize, 256);
        
        this.sendLoop();
      }
    }

    private handleNetworkCongestion() {
      // Congestion Control: Window Decrease
      this.congestion.threshold = Math.max(this.congestion.windowSize / 2, 2);
      this.congestion.windowSize = this.congestion.threshold;
      this.congestion.inSlowStart = false;
      this.currentChunkSize = this.CHUNK_SIZE_MIN; // 청크 사이즈 축소 (constants 활용)
      
      setTimeout(() => this.sendLoop(), 200);
    }

    private checkTimeout(seq: number) {
      if (this.pendingChunks.has(seq)) {
        this.handleNetworkCongestion();
      }
    }

    private calculateProgress(bytes: number) {
      this.totalBytesSent += bytes;
      const elapsed = (Date.now() - this.startTime) / 1000;
      const speed = elapsed > 0 ? this.totalBytesSent / elapsed : 0;
      
      return {
        bytesTransferred: this.totalBytesSent,
        totalBytes: this.manifest.totalSize,
        speed,
        progress: (this.totalBytesSent / this.manifest.totalSize) * 100
      };
    }
  }

  new EnhancedSenderWorker();
})();