/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// 🚀 Direct Download Receiver Worker
// - OPFS 제거 - 브라우저 저장소 quota 제한 없음
// - 메인 스레드의 DirectFileWriter로 청크 전달
// - 진행률 및 속도 측정만 담당
// - Checksum: CRC32 for data integrity verification
// ============================================================================

const HEADER_SIZE = 22; // 18 -> 22로 변경 (Checksum 4byte 추가)
const PROGRESS_REPORT_INTERVAL = 100;
const SPEED_SAMPLE_SIZE = 10;

// CRC32 Checksum 계산 함수
function calculateCRC32(data: Uint8Array): number {
  const CRC_TABLE = new Int32Array(256);

  // CRC 테이블 초기화 (한 번만 실행)
  if (CRC_TABLE[0] === 0) {
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[i] = c;
    }
  }

  let crc = -1; // 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0; // 부호 없는 정수로 변환
}

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
    console.log(
      '[Receiver Worker] Total size:',
      (manifest.totalSize / (1024 * 1024)).toFixed(2),
      'MB'
    );

    self.postMessage({ type: 'storage-ready' });
  }

  private processChunk(packet: ArrayBuffer) {
    if (packet.byteLength < HEADER_SIZE) return;

    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);

    // EOS 체크
    if (fileId === 0xffff) {
      this.finalize();
      return;
    }

    const size = view.getUint32(14, true);
    const receivedChecksum = view.getUint32(18, true); // 🚀 Checksum 읽기

    // 1. 패킷 길이 무결성 검증
    if (packet.byteLength !== HEADER_SIZE + size) {
      console.error('[Receiver Worker] ❌ Corrupt packet size');
      // 추후 NACK 요청 로직 추가 가능
      return;
    }

    // 2. 🚀 데이터 무결성 검증 (CRC32)
    // 헤더를 제외한 실제 데이터 부분 추출
    const dataPart = new Uint8Array(packet, HEADER_SIZE, size);
    const calculatedChecksum = calculateCRC32(dataPart);

    if (receivedChecksum !== calculatedChecksum) {
      console.error(
        `[Receiver Worker] ❌ Checksum mismatch! Expected: ${receivedChecksum.toString(16)}, Calc: ${calculatedChecksum.toString(16)}`
      );
      // 치명적 오류 보고 (현재는 로그만, 추후 재전송 요청으로 연결)
      self.postMessage({
        type: 'error',
        payload: 'Data corruption detected (Checksum mismatch)',
      });
      return;
    }

    this.totalBytesReceived += size;
    this.chunksProcessed++;

    // 청크를 메인 스레드로 전달 (DirectFileWriter가 처리)
    self.postMessage(
      {
        type: 'write-chunk',
        payload: packet,
      },
      [packet]
    ); // Transferable로 전달 (복사 없이)

    // 진행률 및 속도 보고
    const now = Date.now();
    if (now - this.lastReportTime > PROGRESS_REPORT_INTERVAL) {
      // 🚀 [FIX] ZIP 파일의 경우 크기가 더 커질 수 있으므로 100%를 넘지 않도록 Math.min 적용
      const progress =
        this.totalSize > 0
          ? Math.min(100, (this.totalBytesReceived / this.totalSize) * 100)
          : 0;

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
        speed =
          this.speedSamples.reduce((a, b) => a + b, 0) /
          this.speedSamples.length;
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
          speed,
        },
      });
      this.lastReportTime = now;
    }
  }

  private finalize() {
    console.log(
      '[Receiver Worker] Transfer complete. Total:',
      this.totalBytesReceived,
      'bytes'
    );

    self.postMessage({
      type: 'complete',
      payload: { actualSize: this.totalBytesReceived },
    });

    // 상태 초기화
    this.manifest = null;
    this.totalBytesReceived = 0;
    this.totalSize = 0;
  }
}

new ReceiverWorker();
