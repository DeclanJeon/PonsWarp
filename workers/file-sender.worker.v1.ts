/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// 혼잡 제어 상태 관리
interface CongestionState {
  windowSize: number;       // 한 번에 보낼 청크 수
  threshold: number;        // 임계값
  inSlowStart: boolean;     // Slow Start 모드 여부
  rtt: number;              // 왕복 시간 (ms)
  rttVar: number;           // RTT 분산
  timeout: number;          // 타임아웃 시간
}

interface PendingChunk {
  sentAt: number;
  retries: number;
  data: ArrayBuffer; // 재전송을 위해 원본 데이터 보관
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
    
    // 🚀 TCP Reno 스타일 혼잡 제어 변수
    private congestion: CongestionState = {
      windowSize: 8,        // 8개로 시작 (약 512KB)
      threshold: 64,
      inSlowStart: true,
      rtt: 100,             // 초기 예상 RTT
      rttVar: 50,
      timeout: 3000
    };

    private pendingChunks = new Map<number, PendingChunk>(); 
    private chunkSequence = 0; // 고유 시퀀스 번호
    private isLoopRunning = false; // 중복 실행 방지

    constructor() {
      self.onmessage = this.handleMessage.bind(this);
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
            this.sendLoop(); // Push 시작
          }
          break;
        case 'ack-received': 
          this.handleAck(payload.chunkIndex);
          break;
        case 'network-congestion': // Main Thread가 버퍼 가득 참 알림
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
      this.pendingChunks.clear();
      
      // 초기화 로그
      console.log(`[Sender] Init: ${files.length} files, ${manifest.totalSize} bytes`);
      self.postMessage({ type: 'ready' });
    }

    // 🚀 [핵심] Push Loop: 윈도우가 찰 때까지 계속 보냄
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
          
          if (chunkData) {
            this.sendChunk(chunkData);
          } else {
            // 파일 끝, 다음 파일로 넘어가거나 종료
            if (this.currentFileIndex >= this.files.length) {
              break;
            }
          }
        }
      } catch (err) {
        console.error('[Sender] Loop Error:', err);
      } finally {
        this.isLoopRunning = false;
        // 모든 파일 읽음 + 모든 ACK 수신 = 완료
        if (this.currentFileIndex >= this.files.length && this.pendingChunks.size === 0) {
          self.postMessage({ type: 'complete' });
        }
      }
    }

    private async readNextChunk(): Promise<ArrayBuffer | null> {
      const file = this.files[this.currentFileIndex];
      if (!file) return null;

      // 🚀 동적 청크 사이징 (RTT 기반)
      let chunkSize = 64 * 1024; 
      if (this.congestion.rtt < 50) chunkSize = 256 * 1024; // 아주 빠름
      else if (this.congestion.rtt < 150) chunkSize = 128 * 1024; // 빠름
      else if (this.congestion.rtt > 300) chunkSize = 16 * 1024; // 느림

      const start = this.currentFileOffset;
      const end = Math.min(start + chunkSize, file.size);
      
      if (start >= file.size) {
        this.currentFileIndex++;
        this.currentFileOffset = 0;
        return this.readNextChunk(); // 재귀 호출로 다음 파일
      }

      const blob = file.slice(start, end);
      const buffer = await blob.arrayBuffer();
      this.currentFileOffset = end;
      return buffer;
    }

    private sendChunk(data: ArrayBuffer) {
      const seq = this.chunkSequence++;
      
      // 🚀 헤더 작성 (10 Bytes)
      // [FileIndex: 2] [Seq: 4] [DataLen: 4]
      const header = new ArrayBuffer(10);
      const view = new DataView(header);
      view.setUint16(0, this.currentFileIndex, true);
      view.setUint32(2, seq, true);
      view.setUint32(6, data.byteLength, true);

      // 병합 (WebRTC 전송용)
      const packet = new Uint8Array(10 + data.byteLength);
      packet.set(new Uint8Array(header), 0);
      packet.set(new Uint8Array(data), 10);

      // ACK 대기열 등록
      this.pendingChunks.set(seq, {
        sentAt: Date.now(),
        retries: 0,
        data: data // 재전송을 위해 원본 보관
      });

      // 메인 스레드로 전송
      const progressData = this.calculateProgress(data.byteLength);
      self.postMessage({
        type: 'chunk-ready',
        payload: {
          chunk: packet.buffer,
          chunkSequence: seq,
          progressData
        }
      }, [packet.buffer]);

      // 타임아웃 설정
      setTimeout(() => this.checkTimeout(seq), this.congestion.timeout);
    }

    private handleAck(seq: number) {
      const pending = this.pendingChunks.get(seq);
      if (!pending) return; // 이미 처리됨

      // RTT 업데이트 (Jacobson's Algorithm)
      const rttSample = Date.now() - pending.sentAt;
      this.congestion.rtt = 0.875 * this.congestion.rtt + 0.125 * rttSample;
      this.congestion.rttVar = 0.75 * this.congestion.rttVar + 0.25 * Math.abs(this.congestion.rtt - rttSample);
      this.congestion.timeout = this.congestion.rtt + 4 * this.congestion.rttVar;

      this.pendingChunks.delete(seq);
      
      // 🚀 AIMD: 윈도우 증가
      if (this.congestion.inSlowStart) {
        this.congestion.windowSize += 1;
        if (this.congestion.windowSize >= this.congestion.threshold) {
          this.congestion.inSlowStart = false;
        }
      } else {
        // 혼잡 회피: 선형 증가 (대략적으로)
        this.congestion.windowSize += 1 / this.congestion.windowSize;
      }
      
      // 윈도우 상한선 (메모리 보호)
      this.congestion.windowSize = Math.min(this.congestion.windowSize, 512);

      // 자리가 났으니 즉시 다음 청크 전송 시도
      this.sendLoop();
    }

    private handleNetworkCongestion() {
      // 🚀 AIMD: 윈도우 감소 (Multiplicative Decrease)
      this.congestion.threshold = Math.max(this.congestion.windowSize / 2, 2);
      this.congestion.windowSize = this.congestion.threshold;
      this.congestion.inSlowStart = false;
      
      // 잠시 후 재개
      setTimeout(() => this.sendLoop(), 200);
    }

    private checkTimeout(seq: number) {
      if (this.pendingChunks.has(seq)) {
        // 타임아웃 발생 -> 혼잡으로 간주하고 윈도우 줄임
        // 재전송은 SCTP(WebRTC)가 알아서 하므로 앱 레벨에선 윈도우만 조절
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