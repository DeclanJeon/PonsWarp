/**
 * 🔐 Zero-Knowledge Encryption Service
 * Web Crypto API (AES-GCM)를 사용하여 파일을 청크 단위로 암호화/복호화합니다.
 * 키는 URL Hash로만 공유되며 서버에 전송되지 않습니다.
 */

// AES-GCM 설정
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;

export class EncryptionService {
  /**
   * 랜덤 암호화 키 생성 (Base64 URL-safe 문자열 반환)
   */
  public static async generateKey(): Promise<string> {
    const key = await window.crypto.subtle.generateKey(
      { name: ALGORITHM, length: KEY_LENGTH },
      true,
      ['encrypt', 'decrypt']
    );
    const raw = await window.crypto.subtle.exportKey('raw', key);
    return this.arrayBufferToBase64(raw);
  }

  /**
   * Base64 문자열에서 CryptoKey 객체 복원
   */
  public static async importKey(base64Key: string): Promise<CryptoKey> {
    const raw = this.base64ToArrayBuffer(base64Key);
    return await window.crypto.subtle.importKey(
      'raw',
      raw,
      ALGORITHM,
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * 청크 암호화 (IV는 청크 시퀀스 번호 기반으로 생성하여 오버헤드 제거)
   */
  public static async encryptChunk(
    key: CryptoKey,
    data: ArrayBuffer,
    chunkIndex: number
  ): Promise<ArrayBuffer> {
    const iv = this.generateIV(chunkIndex);
    return await window.crypto.subtle.encrypt(
      { name: ALGORITHM, iv: iv as BufferSource },
      key,
      data
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
    return await window.crypto.subtle.decrypt(
      { name: ALGORITHM, iv: iv as BufferSource },
      key,
      data
    );
  }

  // --- Helpers ---

  // 청크 인덱스를 12byte IV로 변환 (Deterministic IV)
  // 보안상 Key가 매 세션 랜덤이므로, IV가 예측 가능해도 안전함.
  private static generateIV(counter: number): Uint8Array {
    const iv = new Uint8Array(12);
    const view = new DataView(iv.buffer);
    // 마지막 4바이트에 청크 인덱스 기록 (40억 개 청크까지 지원)
    view.setUint32(8, counter, false); // Big-Endian
    return iv;
  }

  private static arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private static base64ToArrayBuffer(base64: string): ArrayBuffer {
    const b64 = base64.replace(/-/g, '+').replace(/_/g, '/');
    const binary = window.atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}