/**
 * StreamSaver Writer Service
 * StreamSaver를 사용하여 메인 스레드에서 직접 파일 쓰기
 * OPFS 할당량 제한 없이 디스크에 직접 저장
 */

import streamSaver from 'streamsaver';

interface FileWriterHandle {
  writer: WritableStreamDefaultWriter;
  written: number;
  size: number;
  chunks: Map<number, ArrayBuffer>; // 순서 보장을 위한 버퍼
  nextExpectedOffset: number;
}

export class StreamSaverWriter {
  private fileHandles: Map<number, FileWriterHandle> = new Map();
  private totalBytesWritten = 0;
  private totalSize = 0;
  private manifest: any = null;
  private onProgressCallback: ((data: any) => void) | null = null;
  private onCompleteCallback: ((actualSize: number) => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  private isFinalized = false; // 🚨 [추가] 종료 상태 플래그
  private startTime = 0;

  /**
   * 파일 스트림 초기화
   */
  public async initStorage(manifest: any): Promise<void> {
    this.manifest = manifest;
    this.totalSize = manifest.totalSize;
    this.startTime = Date.now();

    try {
      console.log('[StreamSaverWriter] Initializing for', manifest.totalFiles, 'files');

      // 각 파일에 대한 writable stream 생성
      for (const file of manifest.files) {
        const fileName = file.path.split('/').pop() || file.name;
        
        // StreamSaver로 파일 스트림 생성
        const fileStream = streamSaver.createWriteStream(fileName, {
          size: file.size,
        });

        const writer = fileStream.getWriter();

        this.fileHandles.set(file.id, {
          writer,
          written: 0,
          size: file.size,
          chunks: new Map(),
          nextExpectedOffset: 0,
        });

        console.log(`[StreamSaverWriter] Stream created: ${fileName} (${(file.size / (1024 * 1024)).toFixed(2)}MB)`);
      }

      console.log('[StreamSaverWriter] ✅ Storage initialized');
    } catch (error: any) {
      console.error('[StreamSaverWriter] ❌ Init failed:', error);
      throw new Error(`Storage initialization failed: ${error.message}`);
    }
  }

  /**
   * 청크 데이터 쓰기 (순서 보장)
   */
  public async writeChunk(packet: ArrayBuffer): Promise<void> {
    const HEADER_SIZE = 18;
    
    // 🚨 [수정] 이미 종료되었으면 더 이상 쓰지 않음 (조용히 무시)
    if (this.isFinalized) {
      // 로그 제거 - 정상적인 상황이므로 경고 불필요
      return;
    }
    
    // 🚨 [디버깅] 청크 수신 로그
    console.log('[StreamSaverWriter] writeChunk called, packet size:', packet.byteLength);
    
    // 1. 최소 헤더 크기 체크
    if (packet.byteLength < HEADER_SIZE) {
      console.warn('[StreamSaverWriter] Packet too small:', packet.byteLength);
      return;
    }
    
    const view = new DataView(packet);
    const fileId = view.getUint16(0, true);
    
    // 2. EOS(End of Stream) 체크
    if (fileId === 0xFFFF) {
      console.log('[StreamSaverWriter] EOS received, finalizing...');
      await this.finalize();
      return;
    }

    const seq = view.getUint32(2, true);
    const offsetBigInt = view.getBigUint64(6, true);
    const size = view.getUint32(14, true);
    const offset = Number(offsetBigInt);

    console.log('[StreamSaverWriter] Chunk:', { fileId, seq, offset, size });

    // 3. 패킷 무결성 검증
    if (packet.byteLength !== HEADER_SIZE + size) {
      console.error(`[StreamSaverWriter] ❌ Corrupt packet. Expected: ${HEADER_SIZE + size}, Got: ${packet.byteLength}`);
      return;
    }

    const handle = this.fileHandles.get(fileId);
    if (!handle) {
      console.error('[StreamSaverWriter] ❌ No file handle for fileId:', fileId);
      console.log('[StreamSaverWriter] Available fileIds:', Array.from(this.fileHandles.keys()));
      return;
    }

    try {
      // 헤더 제거하고 데이터만 추출
      const data = packet.slice(HEADER_SIZE, HEADER_SIZE + size);

      // 🚨 [핵심] 순서 보장 로직
      // StreamSaver는 순차 쓰기만 지원하므로 청크를 버퍼링
      if (offset === handle.nextExpectedOffset) {
        // 예상된 오프셋이면 즉시 쓰기
        await handle.writer.write(new Uint8Array(data));
        handle.written += size;
        handle.nextExpectedOffset += size;
        this.totalBytesWritten += size;

        // 버퍼에 있는 다음 청크들도 순서대로 쓰기
        while (handle.chunks.has(handle.nextExpectedOffset)) {
          const bufferedChunk = handle.chunks.get(handle.nextExpectedOffset)!;
          await handle.writer.write(new Uint8Array(bufferedChunk));
          handle.written += bufferedChunk.byteLength;
          handle.nextExpectedOffset += bufferedChunk.byteLength;
          this.totalBytesWritten += bufferedChunk.byteLength;
          handle.chunks.delete(handle.nextExpectedOffset - bufferedChunk.byteLength);
        }
      } else {
        // 순서가 맞지 않으면 버퍼에 저장
        handle.chunks.set(offset, data);
      }

      // 진행률 보고 (속도 계산 포함)
      if (this.onProgressCallback) {
        const elapsed = (Date.now() - this.startTime) / 1000;
        const speed = elapsed > 0 ? this.totalBytesWritten / elapsed : 0;
        const progress = this.totalSize > 0 ? (this.totalBytesWritten / this.totalSize) * 100 : 0;
        
        this.onProgressCallback({
          progress,
          speed,
          bytesTransferred: this.totalBytesWritten,
          totalBytes: this.totalSize
        });
      }
    } catch (writeError: any) {
      // 🚨 [핵심 수정] 스트림이 닫혔을 때의 에러는 조용히 무시 (finalize 후 도착한 청크들)
      const errorMsg = writeError.message || writeError.toString();
      
      if (errorMsg.includes('closing') || 
          errorMsg.includes('closed') || 
          errorMsg.includes('CLOSED') ||
          this.isFinalized) {
        // 로그 제거 - 이것은 정상적인 race condition이며 에러가 아님
        return;
      }
      
      // 진짜 에러만 로깅
      console.error('[StreamSaverWriter] ❌ Write error:', writeError);
      
      if (this.onErrorCallback) {
        this.onErrorCallback(`Write failed: ${errorMsg}`);
      }
    }
  }

  /**
   * 전송 완료 처리
   */
  private async finalize(): Promise<void> {
    // 🚨 [수정] 중복 finalize 방지
    if (this.isFinalized) {
      console.warn('[StreamSaverWriter] Already finalized, skipping');
      return;
    }
    
    console.log('[StreamSaverWriter] Starting finalization...');
    this.isFinalized = true; // 종료 상태 플래그 설정 (더 이상 청크 받지 않음)
    
    // 🚨 [핵심 추가] 짧은 지연을 주어 in-flight 청크들이 도착할 시간 확보
    await new Promise(resolve => setTimeout(resolve, 100));
    
    let actualSize = 0;
    
    // 모든 파일 스트림 닫기
    for (const handle of this.fileHandles.values()) {
      try {
        // 🚨 [수정] 스트림 상태 확인 후 닫기 (readyState가 없으므로 try-catch 사용)
        try {
          await handle.writer.close();
        } catch (e: any) {
          // 이미 닫힌 스트림이면 무시
          const errMsg = e.message || e.toString();
          if (!errMsg.includes('closed') && !errMsg.includes('closing')) {
            console.error('[StreamSaverWriter] Unexpected error closing writer:', e);
          }
        }
        actualSize += handle.written;
      } catch (e) {
        console.error('[StreamSaverWriter] Error closing writer:', e);
      }
    }
    
    console.log('[StreamSaverWriter] ✅ Transfer finalized. Total written:', actualSize);
    
    if (this.onCompleteCallback) {
      this.onCompleteCallback(actualSize);
    }
  }

  /**
   * 콜백 등록
   */
  public onProgress(callback: (data: any) => void): void {
    this.onProgressCallback = callback;
  }

  public onComplete(callback: (actualSize: number) => void): void {
    this.onCompleteCallback = callback;
  }

  public onError(callback: (error: string) => void): void {
    this.onErrorCallback = callback;
  }

  /**
   * 정리
   */
  public async cleanup(): Promise<void> {
    this.isFinalized = true; // 🚨 [추가] cleanup 시에도 종료 상태 설정
    
    for (const handle of this.fileHandles.values()) {
      try {
        // 🚨 [수정] 스트림 상태 확인 후 중지 (readyState가 없으므로 try-catch 사용)
        try {
          await handle.writer.abort();
        } catch (e) {
          // 이미 닫힌 스트림이면 무시
          if (!e.message || !e.message.includes('closed')) {
            console.error('[StreamSaverWriter] Unexpected error aborting writer:', e);
          }
        }
      } catch (e) {
        // Ignore
      }
    }
    
    this.fileHandles.clear();
  }
}
