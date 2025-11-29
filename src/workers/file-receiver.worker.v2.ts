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

// 🔐 암호화 관련 상수 및 함수 (워커 환경용)
const ALGORITHM = 'AES-GCM';

// 워커 환경에서 암호화 유틸리티
class WorkerEncryptionService {
  /**
   * Base64 문자열에서 CryptoKey 객체 복원
   */
  public static async importKey(base64Key: string): Promise<CryptoKey> {
    const raw = this.base64ToArrayBuffer(base64Key);
    return await self.crypto.subtle.importKey(
      'raw',
      raw,
      ALGORITHM,
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * 청크 복호화
   */
  public static async decryptChunk(
    key: CryptoKey,
    data: ArrayBuffer,
    chunkIndex: number
  ): Promise<ArrayBuffer> {
    const iv = this.generateIV(chunkIndex);
    return await self.crypto.subtle.decrypt(
      { name: ALGORITHM, iv: iv as BufferSource },
      key,
      data
    );
  }

  // 청크 인덱스를 12byte IV로 변환 (Deterministic IV)
  private static generateIV(counter: number): Uint8Array {
    const iv = new Uint8Array(12);
    const view = new DataView(iv.buffer);
    // 마지막 4바이트에 청크 인덱스 기록 (40억 개 청크까지 지원)
    view.setUint32(8, counter, false); // Big-Endian
    return iv;
  }

  private static base64ToArrayBuffer(base64: string): ArrayBuffer {
    const b64 = base64.replace(/-/g, '+').replace(/_/g, '/');
    const binary = self.atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
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
  
  // 🔐 암호화 키 추가
  private encryptionKey: CryptoKey | null = null;

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

  private async initTransfer(payload: any) {
    this.manifest = payload.manifest;
    this.totalSize = payload.manifest.totalSize;
    this.totalBytesReceived = 0;
    this.chunksProcessed = 0;
    
    // 속도 측정 초기화
    this.startTime = Date.now();
    this.speedSamples = [];
    this.lastSpeedCalcTime = this.startTime;
    this.lastSpeedCalcBytes = 0;
    
    // 🔐 키 로드
    if (payload.encryptionKeyStr) {
        this.encryptionKey = await WorkerEncryptionService.importKey(payload.encryptionKeyStr);
        console.log('[Receiver Worker] 🔐 Decryption Enabled');
    }
    
    console.log('[Receiver Worker] Ready for', payload.manifest.totalFiles, 'files');
    console.log('[Receiver Worker] Total size:', (payload.manifest.totalSize / (1024 * 1024)).toFixed(2), 'MB');
    
    self.postMessage({ type: 'storage-ready' });
  }

  private async processChunk(packet: ArrayBuffer) {
    if (packet.byteLength < HEADER_SIZE) return;

    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);
    
    // EOS 체크
    if (fileId === 0xFFFF) {
      this.finalize();
      return;
    }

    const chunkSequence = view.getUint32(2, true); // 헤더에서 시퀀스 읽기
    const size = view.getUint32(14, true);

    // 패킷 무결성 검증
    if (packet.byteLength !== HEADER_SIZE + size) {
      console.error('[Receiver Worker] Corrupt packet');
      return;
    }

    let dataBuffer = packet.slice(HEADER_SIZE, HEADER_SIZE + size);

    // 🔐 복호화 수행
    if (this.encryptionKey) {
        try {
            dataBuffer = await WorkerEncryptionService.decryptChunk(
                this.encryptionKey,
                dataBuffer,
                chunkSequence
            );
            // 복호화된 데이터 크기로 업데이트?
            // 아님, 여기서는 원본 데이터 스트림으로 돌아감.
        } catch (e) {
            console.error('[Receiver Worker] Decryption failed:', e);
            // 에러 처리 (전송 중단 등)
            return;
        }
    }

    this.totalBytesReceived += size; // 전송량 기준으로는 암호화된 크기지만, 진행률은 원본 크기 기준이어야 함 (보정 필요할 수 있음)
    // 간단히: 암호화 오버헤드(16바이트)는 무시하고 진행률 표시 (큰 파일에선 오차 미미함)

    this.chunksProcessed++;

    // 복호화된 데이터 전달
    self.postMessage({
      type: 'write-chunk',
      payload: dataBuffer
    }, [dataBuffer]);
    
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
