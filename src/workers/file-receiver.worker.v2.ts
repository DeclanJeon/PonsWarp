/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// 🚀 Direct Download Receiver Worker
// - OPFS 제거 - 브라우저 저장소 quota 제한 없음
// - 메인 스레드의 DirectFileWriter로 청크 전달
// - 진행률 및 속도 측정만 담당
// ============================================================================

const HEADER_SIZE = 18;
const PROGRESS_REPORT_INTERVAL = 100;
const SPEED_SAMPLE_SIZE = 10;

class ReceiverWorker {
  private totalBytesReceived = 0;
  private totalSize = 0;
  private manifest: any = null;
  private lastReportTime = 0;
  private chunksProcessed = 0;
  
  // 속도 측정용
  private startTime = 0;
  private speedSamples: number[] = [];
  private lastSpeedCalcTime = 0;
  private lastSpeedCalcBytes = 0;

  constructor() {
    self.onmessage = this.handleMessage.bind(this);
  }

  private handleMessage(e: MessageEvent) {
    const { type, payload } = e.data;
    
    switch (type) {
      case 'init-manifest':
        this.initTransfer(payload);
        break;
      case 'chunk':
        this.processChunk(payload);
        break;
    }
  }

  private initTransfer(manifest: any) {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;
    this.totalBytesReceived = 0;
    this.chunksProcessed = 0;
    
    // 속도 측정 초기화
    this.startTime = Date.now();
    this.speedSamples = [];
    this.lastSpeedCalcTime = this.startTime;
    this.lastSpeedCalcBytes = 0;
    
    console.log('[Receiver Worker] Ready for', manifest.totalFiles, 'files');
    console.log('[Receiver Worker] Total size:', (manifest.totalSize / (1024 * 1024)).toFixed(2), 'MB');
    
    self.postMessage({ type: 'storage-ready' });
  }

  private processChunk(packet: ArrayBuffer) {
    if (packet.byteLength < HEADER_SIZE) return;

    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);
    
    // EOS 체크
    if (fileId === 0xFFFF) {
      this.finalize();
      return;
    }

    const size = view.getUint32(14, true);

    // 패킷 무결성 검증
    if (packet.byteLength !== HEADER_SIZE + size) {
      console.error('[Receiver Worker] Corrupt packet');
      return;
    }

    this.totalBytesReceived += size;
    this.chunksProcessed++;

    // 청크를 메인 스레드로 전달 (DirectFileWriter가 처리)
    self.postMessage({ 
      type: 'write-chunk', 
      payload: packet 
    }, [packet]); // Transferable로 전달 (복사 없이)
    
    // 진행률 및 속도 보고
    const now = Date.now();
    if (now - this.lastReportTime > PROGRESS_REPORT_INTERVAL) {
      const progress = this.totalSize > 0 ? (this.totalBytesReceived / this.totalSize) * 100 : 0;
      
      // 속도 계산
      const timeDelta = now - this.lastSpeedCalcTime;
      const bytesDelta = this.totalBytesReceived - this.lastSpeedCalcBytes;
      let speed = 0;
      
      if (timeDelta > 0 && bytesDelta > 0) {
        const instantSpeed = bytesDelta / (timeDelta / 1000);
        this.speedSamples.push(instantSpeed);
        if (this.speedSamples.length > SPEED_SAMPLE_SIZE) {
          this.speedSamples.shift();
        }
        speed = this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length;
      }
      
      this.lastSpeedCalcTime = now;
      this.lastSpeedCalcBytes = this.totalBytesReceived;
      
      self.postMessage({ 
        type: 'progress', 
        payload: { 
          progress,
          bytesWritten: this.totalBytesReceived,
          totalBytes: this.totalSize,
          chunksProcessed: this.chunksProcessed,
          speed
        } 
      });
      this.lastReportTime = now;
    }
  }

  private finalize() {
    console.log('[Receiver Worker] Transfer complete. Total:', this.totalBytesReceived, 'bytes');
    
    self.postMessage({
      type: 'complete',
      payload: { actualSize: this.totalBytesReceived }
    });
    
    // 상태 초기화
    this.manifest = null;
    this.totalBytesReceived = 0;
    this.totalSize = 0;
  }
}

new ReceiverWorker();
