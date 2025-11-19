/**
 * Enhanced Worker Factory with OPFS Streaming, hash-wasm, and Multi-Channel Support
 */

// 공통 유틸리티
const SHARED_UTILS = `
  const MAX_MESSAGE_SIZE = 16 * 1024;
  
  const calculateDynamicChunkSize = (baseSize, avgRTT, bufferedAmount, successRate) => {
    let size = baseSize;
    
    if (avgRTT < 50) {
      size = Math.min(64 * 1024, size * 1.5);
    } else if (avgRTT > 200) {
      size = Math.max(16 * 1024, size * 0.7);
    }
    
    if (bufferedAmount > 512 * 1024) {
      size = Math.max(16 * 1024, size * 0.8);
    }
    
    if (successRate < 0.95) {
      size = Math.max(16 * 1024, size * 0.9);
    }
    
    return Math.floor(size);
  };
  
  class FileChunkReader {
    constructor(file, chunkSize) {
      this.file = file;
      this.chunkSize = chunkSize;
      this.activeReads = 0;
      this.MAX_CONCURRENT_READS = 5;
    }
    
    async readChunk(index) {
      if (this.activeReads >= this.MAX_CONCURRENT_READS) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      this.activeReads++;
      
      try {
        const start = index * this.chunkSize;
        const end = Math.min(start + this.chunkSize, this.file.size);
        const blob = this.file.slice(start, end);
        const arrayBuffer = await blob.arrayBuffer();
        return arrayBuffer;
      } finally {
        this.activeReads--;
      }
    }
    
    getTotalChunks() {
      return Math.ceil(this.file.size / this.chunkSize);
    }
  }
`;

// 개선된 Sender Worker
const ENHANCED_SENDER_WORKER = `
  ${SHARED_UTILS}
  
  // hash-wasm을 사용한 체크섬 계산 (native crypto API 사용)
  const calculateFileChecksum = async (file) => {
    const chunkSize = 10 * 1024 * 1024; // 10MB
    let offset = 0;
    const chunks = [];
    
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + chunkSize);
      const buffer = await chunk.arrayBuffer();
      chunks.push(new Uint8Array(buffer));
      offset += chunkSize;
    }
    
    // 모든 청크를 하나로 합치기
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let position = 0;
    
    for (const chunk of chunks) {
      combined.set(chunk, position);
      position += chunk.length;
    }
    
    // SHA-256 해시 계산
    const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  };
  
  class EnhancedFileSender {
    constructor() {
      this.pendingChunks = new Map();
      this.ackedChunks = new Set();
      this.chunkSize = 16 * 1024; // 수정: 안정성을 위해 16KB로 줄임
      this.congestionWindow = 4;
      this.slowStartThreshold = 64;
      this.inSlowStart = true;
      this.consecutiveSuccesses = 0;
      this.consecutiveTimeouts = 0;
      this.rttSamples = [];
      this.averageRTT = 1000;
      self.onmessage = this.handleMessage.bind(this);
    }
    
    async handleMessage(e) {
      const { type, payload } = e.data;
      
      switch (type) {
        case 'start-transfer':
          await this.startTransfer(payload);
          break;
        // ACK 메커니즘은 단일 채널에서는 필요 없음
        // case 'ack-received':
        //   this.handleAck(payload);
        //   break;
        case 'buffer-status':
          this.adjustWindow(payload.bufferedAmount);
          break;
      }
    }
    
    async startTransfer(payload) {
      this.file = payload.file;
      this.fileName = payload.fileName;
      this.fileSize = payload.fileSize;
      this.transferId = payload.transferId;
      this.chunkSize = payload.chunkSize || 16 * 1024; // 수정: 안정성을 위해 16KB로 줄임
      this.totalChunks = Math.ceil(this.fileSize / this.chunkSize);
      this.reader = new FileChunkReader(this.file, this.chunkSize);
      this.startTime = Date.now();
      this.nextIndex = 0;
      
      // 체크섬 계산 (백그라운드)
      try {
        const checksum = await calculateFileChecksum(this.file);
        self.postMessage({
          type: 'checksum-ready',
          payload: { transferId: this.transferId, checksum }
        });
      } catch (error) {
        console.error('Checksum calculation failed:', error);
      }
      
      // 전송 시작
      this.sendNextBatch();
    }
    
    async sendNextBatch() {
      const maxPending = Math.floor(this.congestionWindow);
      
      while (this.pendingChunks.size < maxPending && this.nextIndex < this.totalChunks) {
        const idx = this.nextIndex++;
        
        if (this.ackedChunks.has(idx)) {
          continue;
        }
        
        try {
          const data = await this.reader.readChunk(idx);
          const packet = this.createPacket(idx, data);
          
          this.pendingChunks.set(idx, {
            sentAt: Date.now(),
            retries: 0,
            rawData: data
          });
          
          self.postMessage({
            type: 'chunk-ready',
            payload: {
              chunk: packet,
              index: idx,
              progress: (idx / this.totalChunks) * 100
            }
          }, [packet]);
          
        } catch (error) {
          console.error('Read error:', error);
        }
      }
      
      // 완료 체크
      if (this.ackedChunks.size === this.totalChunks) {
        const totalTime = (Date.now() - this.startTime) / 1000;
        const averageSpeed = this.fileSize / totalTime;
        
        self.postMessage({
          type: 'complete',
          payload: {
            transferId: this.transferId,
            averageSpeed,
            totalTime
          }
        });
      }
    }
    
    createPacket(chunkIndex, data) {
      const idBytes = new TextEncoder().encode(this.transferId);
      const headerSize = 1 + 2 + idBytes.length + 4 + 4;
      const totalSize = headerSize + data.byteLength;
      const packet = new ArrayBuffer(totalSize);
      const view = new DataView(packet);
      
      let offset = 0;
      view.setUint8(offset, 1); offset++;
      view.setUint16(offset, idBytes.length, true); offset += 2; // 수정: Little Endian
      new Uint8Array(packet, offset, idBytes.length).set(idBytes); offset += idBytes.length;
      view.setUint32(offset, chunkIndex, true); offset += 4; // 수정: Little Endian
      view.setUint32(offset, data.byteLength, true); offset += 4; // 수정: Little Endian
      new Uint8Array(packet, offset, data.byteLength).set(new Uint8Array(data));
      
      return packet;
    }
    
    handleAck(payload) {
      const { chunkIndex } = payload;
      
      if (this.ackedChunks.has(chunkIndex)) {
        return;
      }
      
      const pending = this.pendingChunks.get(chunkIndex);
      if (!pending) {
        return;
      }
      
      // RTT 계산
      const rtt = Date.now() - pending.sentAt;
      this.updateRTT(rtt);
      
      // 성공 카운터 증가
      this.consecutiveSuccesses++;
      this.consecutiveTimeouts = 0;
      
      // ACK 처리
      this.ackedChunks.add(chunkIndex);
      this.pendingChunks.delete(chunkIndex);
      
      // 혼잡 제어 (AIMD)
      if (this.inSlowStart) {
        this.congestionWindow = Math.min(
          this.slowStartThreshold,
          this.congestionWindow * 2
        );
        
        if (this.congestionWindow >= this.slowStartThreshold) {
          this.inSlowStart = false;
        }
      } else {
        this.congestionWindow = Math.min(128, this.congestionWindow + 1);
      }
      
      // 다음 배치 전송
      this.sendNextBatch();
    }
    
    updateRTT(rtt) {
      this.rttSamples.push(rtt);
      
      if (this.rttSamples.length > 10) {
        this.rttSamples.shift();
      }
      
      this.averageRTT = this.rttSamples.reduce((sum, val) => sum + val, 0) / this.rttSamples.length;
    }
    
    adjustWindow(bufferedAmount) {
      if (bufferedAmount > 512 * 1024) {
        // 버퍼 포화 시 윈도우 축소
        this.congestionWindow = Math.max(2, Math.floor(this.congestionWindow * 0.8));
        this.inSlowStart = false;
      }
    }
  }
  
  new EnhancedFileSender();
`;

// 개선된 Receiver Worker (OPFS 스트리밍)
const ENHANCED_RECEIVER_WORKER = `
  ${SHARED_UTILS}
  
  class StreamingOPFSWriter {
    constructor() {
      this.handle = null;
      this.writeOffset = 0;
      this.chunkBuffer = new Map();
      this.receivedBytes = 0;
      this.fileSize = 0;
      this.fileName = '';
      this.totalChunks = 0; // 추가: 전체 청크 수 추적
      this.receivedCount = 0; // 추가: 받은 청크 수 추적
      self.onmessage = this.handleMessage.bind(this);
    }
    
    async handleMessage(e) {
      const { type, payload } = e.data;
      
      switch (type) {
        case 'init-write':
          await this.init(payload);
          break;
        case 'write-chunk':
          await this.writeChunk(payload);
          break;
        // 추가: 조립 요청 처리 (검증 로직 포함)
        case 'assemble':
          await this.handleAssembleRequest(payload.transferId);
          break;
      }
    }
    
    async init({ transferId, fileName, fileSize }) {
      try {
        this.transferId = transferId;
        this.fileName = fileName;
        this.fileSize = fileSize;
        
        // 추가: 전체 청크 수 계산 (16KB 기준)
        this.totalChunks = Math.ceil(fileSize / (16 * 1024));
        this.receivedCount = 0;
        
        // OPFS 초기화
        const root = await navigator.storage.getDirectory();
        const fileHandle = await root.getFileHandle(fileName, { create: true });
        this.handle = await fileHandle.createSyncAccessHandle();
        
        // 파일 크기 미리 할당 (성능 향상)
        this.handle.truncate(fileSize);
        
        self.postMessage({ type: 'ready', payload: { transferId } });
        
      } catch (error) {
        console.error('OPFS init failed:', error);
        self.postMessage({ type: 'error', payload: { error: error.message } });
      }
    }
    
    async writeChunk({ transferId, data, index }) {
      if (!this.handle) {
        return;
      }
      
      // 수정: payload.data는 이제 헤더가 제거된 순수 파일 데이터입니다.
      // 메인 스레드에서 이미 정확하게 잘라서 보냈으므로 그대로 래핑만 합니다.
      // slice() 대신 subarray()를 사용하여 메모리 복사 방지 (Zero-Copy)
      const fullUint8 = new Uint8Array(data);
      const chunkIndex = index || 0; // 인덱스가 없으면 0으로 기본값 설정
      const chunkSize = 16 * 1024; // 수정: 16KB로 통일
      
      // 현재 청크 인덱스를 기반으로 쓰기 위치 계산
      const targetWriteOffset = chunkIndex * chunkSize;
      
      // 디버깅용 로그 (필요시 주석 해제)
      // console.log('Chunk:', chunkIndex, 'Target:', targetWriteOffset, 'Current:', this.writeOffset);

      // 순서가 맞으면 즉시 쓰기
      if (targetWriteOffset === this.writeOffset) {
        // subarray()를 사용하여 View만 전달 (Zero-Copy)
        this.handle.write(fullUint8, { at: this.writeOffset });
        this.writeOffset += fullUint8.byteLength;
        this.receivedBytes += fullUint8.byteLength;
        this.receivedCount++; // 추가: 받은 청크 수 증가
        
        // 버퍼에 대기 중인 다음 청크들 처리 (연속된 청크가 있으면 계속 씀)
        let nextIndex = chunkIndex + 1;
        
        while (this.chunkBuffer.has(nextIndex)) {
          const nextData = this.chunkBuffer.get(nextIndex);
          
          this.handle.write(nextData, { at: this.writeOffset });
          this.writeOffset += nextData.byteLength;
          this.receivedBytes += nextData.byteLength;
          this.receivedCount++; // 추가: 받은 청크 수 증가
          
          this.chunkBuffer.delete(nextIndex);
          nextIndex++;
        }
      } else {
        // 순서가 안 맞으면 버퍼에 저장 (키는 chunkIndex)
        // slice()를 사용하여 복사본 저장 (버퍼가 사라질 수 있으므로)
        this.chunkBuffer.set(chunkIndex, fullUint8.slice());
        this.receivedCount++; // 추가: 받은 청크 수 증가
      }
      
      // 진행률 보고
      const progress = (this.receivedBytes / this.fileSize) * 100;
      self.postMessage({
        type: 'progress',
        payload: { transferId, progress }
      });
      
      // 완료 체크
      if (this.receivedBytes >= this.fileSize) {
        this.finalize();
      }
    }
    
    // 추가: 조립 요청 처리 (검증 로직 포함)
    async handleAssembleRequest(transferId) {
      // 핵심 방어 로직: 청크 개수가 모자라면 완료 처리 거부
      if (this.receivedCount < this.totalChunks) {
        console.warn(\`[Receiver Worker] ⚠️ Premature assemble request ignored. Received: \${this.receivedCount}/\${this.totalChunks}\`);
        return;
      }
      
      // 개수가 맞으면 정상적으로 완료 처리
      this.finalize();
    }
    
    finalize() {
      if (!this.handle) {
        return;
      }
      
      this.handle.flush();
      this.handle.close();
      this.handle = null;
      
      console.log(\`[Receiver Worker] ✅ Transfer completed. Received: \${this.receivedCount}/\${this.totalChunks} chunks\`);
      
      self.postMessage({
        type: 'complete',
        payload: {
          transferId: this.transferId,
          fileName: this.fileName
        }
      });
    }
  }
  
  new StreamingOPFSWriter();
`;

export const getSenderWorker = () => {
  const blob = new Blob([ENHANCED_SENDER_WORKER], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
};

export const getReceiverWorker = () => {
  const blob = new Blob([ENHANCED_RECEIVER_WORKER], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
};

// v1 워커들 export (filetransfer.md v1 호환용)
export const getSenderWorkerV1 = () => {
  // Vite의 워커 임포트 사용
  return new Worker(
    new URL('../workers/file-sender.worker.v1.ts', import.meta.url),
    { type: 'module' }
  );
};

export const getReceiverWorkerV1 = () => {
  // Vite의 워커 임포트 사용
  return new Worker(
    new URL('../workers/file-receiver.worker.v1.ts', import.meta.url),
    { type: 'module' }
  );
};
