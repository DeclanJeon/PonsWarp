/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// 🚀 Receiver Worker V3 (WASM Core + E2E Decryption)
// - Packet Verification: Rust/WASM (pons-core-wasm)
// - E2E Decryption: AES-256-GCM (pons-core-wasm)
// - Direct download to main thread (no OPFS)
// ============================================================================

import init, { PacketDecoder, CryptoSession } from 'pons-core-wasm';

const HEADER_SIZE = 22;
const ENCRYPTED_HEADER_SIZE = 38;
const PROGRESS_REPORT_INTERVAL = 100;
const SPEED_SAMPLE_SIZE = 10;

let wasmReady = false;

// 🔐 E2E Decryption
let cryptoSession: CryptoSession | null = null;
let decryptionEnabled = false;

async function initWasm() {
  try {
    await init();
    wasmReady = true;
    console.log('[Receiver Worker] WASM initialized');
  } catch (e) {
    console.error('[Receiver Worker] WASM init failed:', e);
    wasmReady = false;
  }
}

// Fallback CRC32
function calculateCRC32Fallback(data: Uint8Array): number {
  const CRC_TABLE = new Int32Array(256);
  if (CRC_TABLE[0] === 0) {
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

class ReceiverWorker {
  private totalBytesReceived = 0;
  private totalSize = 0;
  private manifest: any = null;
  private lastReportTime = 0;
  private chunksProcessed = 0;

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
      case 'set-encryption-key':
        this.setEncryptionKey(payload);
        break;
    }
  }

  /**
   * 🔐 복호화 키 설정
   */
  private setEncryptionKey(payload: {
    sessionKey: Uint8Array;
    randomPrefix: Uint8Array;
  }) {
    try {
      if (!wasmReady) {
        console.error('[Receiver Worker] WASM not ready for decryption');
        self.postMessage({
          type: 'encryption-error',
          payload: 'WASM not initialized',
        });
        return;
      }

      cryptoSession = new CryptoSession(
        payload.sessionKey,
        payload.randomPrefix
      );
      decryptionEnabled = true;
      console.log('[Receiver Worker] 🔐 E2E decryption enabled');
      self.postMessage({ type: 'encryption-ready' });
    } catch (e: any) {
      console.error('[Receiver Worker] Decryption setup failed:', e);
      self.postMessage({ type: 'encryption-error', payload: e.message });
    }
  }

  private initTransfer(manifest: any) {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;
    this.totalBytesReceived = 0;
    this.chunksProcessed = 0;

    this.startTime = Date.now();
    this.speedSamples = [];
    this.lastSpeedCalcTime = this.startTime;
    this.lastSpeedCalcBytes = 0;

    console.log('[Receiver Worker] Ready for', manifest.totalFiles, 'files');
    console.log(
      '[Receiver Worker] WASM:',
      wasmReady,
      ', Decryption:',
      decryptionEnabled
    );
    console.log(
      '[Receiver Worker] Total size:',
      (manifest.totalSize / (1024 * 1024)).toFixed(2),
      'MB'
    );

    self.postMessage({ type: 'storage-ready' });
  }

  private processChunk(packet: ArrayBuffer) {
    const packetArray = new Uint8Array(packet);

    // 암호화된 패킷인지 확인 (version byte = 0x02)
    const isEncrypted = packetArray[0] === 0x02;

    if (isEncrypted) {
      this.processEncryptedChunk(packet, packetArray);
    } else {
      this.processPlainChunk(packet, packetArray);
    }
  }

  /**
   * 🔐 암호화된 패킷 처리
   */
  private processEncryptedChunk(packet: ArrayBuffer, packetArray: Uint8Array) {
    if (packet.byteLength < ENCRYPTED_HEADER_SIZE + 16) {
      console.error('[Receiver Worker] ❌ Encrypted packet too short');
      return;
    }

    if (!decryptionEnabled || !cryptoSession) {
      console.error('[Receiver Worker] ❌ Decryption not enabled');
      self.postMessage({
        type: 'error',
        payload: 'Received encrypted packet but decryption not enabled',
      });
      return;
    }

    try {
      // WASM으로 복호화
      const decryptedData = cryptoSession.decrypt_chunk(packetArray);

      this.totalBytesReceived += decryptedData.length;
      this.chunksProcessed++;

      // 복호화된 데이터를 메인 스레드로 전달
      // 새 패킷 형식으로 재구성 (비암호화 형식)
      const outputPacket = this.createOutputPacket(decryptedData);

      self.postMessage({ type: 'write-chunk', payload: outputPacket }, [
        outputPacket,
      ]);

      this.reportProgress();
    } catch (e: any) {
      console.error('[Receiver Worker] ❌ Decryption failed:', e);
      self.postMessage({
        type: 'error',
        payload: 'Decryption failed: ' + e.message,
      });
    }
  }

  /**
   * 비암호화 패킷 처리 (기존 로직)
   */
  private processPlainChunk(packet: ArrayBuffer, packetArray: Uint8Array) {
    if (packet.byteLength < HEADER_SIZE) return;

    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);

    // EOS 체크
    if (fileId === 0xffff) {
      this.finalize();
      return;
    }

    const size = view.getUint32(14, true);
    const receivedChecksum = view.getUint32(18, true);

    if (packet.byteLength !== HEADER_SIZE + size) {
      console.error('[Receiver Worker] ❌ Corrupt packet size');
      return;
    }

    const dataPart = packetArray.subarray(HEADER_SIZE, HEADER_SIZE + size);

    // 무결성 검증
    if (wasmReady) {
      const isValid = PacketDecoder.verify(packetArray);
      if (!isValid) {
        console.error('[Receiver Worker] ❌ WASM verification failed');
        self.postMessage({
          type: 'error',
          payload: 'Data corruption detected (WASM verification)',
        });
        return;
      }
    } else {
      const calculatedChecksum = calculateCRC32Fallback(dataPart);
      if (receivedChecksum !== calculatedChecksum) {
        console.error('[Receiver Worker] ❌ Checksum mismatch');
        self.postMessage({
          type: 'error',
          payload: 'Data corruption detected (Checksum mismatch)',
        });
        return;
      }
    }

    this.totalBytesReceived += size;
    this.chunksProcessed++;

    self.postMessage({ type: 'write-chunk', payload: packet }, [packet]);

    this.reportProgress();
  }

  /**
   * 복호화된 데이터를 출력 패킷으로 변환
   */
  private createOutputPacket(data: Uint8Array): ArrayBuffer {
    const packet = new ArrayBuffer(HEADER_SIZE + data.length);
    const view = new DataView(packet);
    const arr = new Uint8Array(packet);

    view.setUint16(0, 0, true); // fileIndex
    view.setUint32(2, this.chunksProcessed, true); // chunkIndex
    view.setBigUint64(6, BigInt(this.totalBytesReceived - data.length), true); // offset
    view.setUint32(14, data.length, true); // length
    view.setUint32(18, 0, true); // checksum (이미 검증됨)
    arr.set(data, HEADER_SIZE);

    return packet;
  }

  private reportProgress() {
    const now = Date.now();
    if (now - this.lastReportTime > PROGRESS_REPORT_INTERVAL) {
      const progress =
        this.totalSize > 0
          ? Math.min(100, (this.totalBytesReceived / this.totalSize) * 100)
          : 0;

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
          encrypted: decryptionEnabled,
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

    this.manifest = null;
    this.totalBytesReceived = 0;
    this.totalSize = 0;
    cryptoSession?.reset();
  }
}

// 🚀 Worker 시작
initWasm()
  .then(() => {
    new ReceiverWorker();
  })
  .catch(() => {
    console.warn('[Receiver Worker] WASM failed, using fallback');
    new ReceiverWorker();
  });
