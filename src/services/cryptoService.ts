/**
 * E2E 암호화 서비스
 * 
 * ECDH 키 교환 + HKDF 키 유도를 통한 세션 키 생성
 * Web Crypto API 기반 구현
 */

export interface KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface CryptoHandshakeMessage {
  type: 'CRYPTO_INIT' | 'CRYPTO_PUBLIC_KEY' | 'CRYPTO_KEY_CONFIRM' | 'CRYPTO_READY';
  version?: number;
  algorithms?: string[];
  publicKey?: string;
  salt?: string;
  confirmation?: string;
}

const CRYPTO_VERSION = 1;
const SUPPORTED_ALGORITHMS = ['ECDH-P256', 'AES-256-GCM', 'HKDF-SHA256'];
const HKDF_INFO = new TextEncoder().encode('PonsWarp-E2E-v1');

export class CryptoService {
  private keyPair: KeyPair | null = null;
  private sessionKey: Uint8Array | null = null;
  private salt: Uint8Array | null = null;
  private peerPublicKey: Uint8Array | null = null;
  private isInitiator: boolean = false;

  /**
   * ECDH 키 쌍 생성
   * @returns Base64 인코딩된 공개키
   */
  async generateKeyPair(): Promise<string> {
    this.keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    ) as CryptoKeyPair;

    const publicKeyRaw = await crypto.subtle.exportKey(
      'raw',
      this.keyPair.publicKey
    );

    return this.arrayBufferToBase64(publicKeyRaw);
  }

  /**
   * Salt 생성 (Initiator만 호출)
   */
  generateSalt(): string {
    this.salt = crypto.getRandomValues(new Uint8Array(32));
    this.isInitiator = true;
    return this.arrayBufferToBase64(this.salt.buffer as ArrayBuffer);
  }

  /**
   * Salt 설정 (Responder가 호출)
   */
  setSalt(saltBase64: string): void {
    this.salt = this.base64ToUint8Array(saltBase64);
    this.isInitiator = false;
  }

  /**
   * 피어의 공개키로 세션 키 유도
   */
  async deriveSessionKey(peerPublicKeyBase64: string): Promise<void> {
    if (!this.keyPair) {
      throw new Error('Key pair not generated');
    }
    if (!this.salt) {
      throw new Error('Salt not set');
    }

    this.peerPublicKey = this.base64ToUint8Array(peerPublicKeyBase64);

    const peerPublicKey = await crypto.subtle.importKey(
      'raw',
      this.peerPublicKey.buffer as ArrayBuffer,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    // ECDH 공유 비밀 생성
    const sharedSecret = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerPublicKey },
      this.keyPair.privateKey,
      256
    );

    // HKDF로 세션 키 유도
    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      sharedSecret,
      'HKDF',
      false,
      ['deriveBits']
    );

    const sessionKeyBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: this.salt.buffer as ArrayBuffer,
        info: HKDF_INFO.buffer as ArrayBuffer,
      },
      hkdfKey,
      256
    );

    this.sessionKey = new Uint8Array(sessionKeyBits);
    console.log('[CryptoService] Session key derived successfully');
  }

  /**
   * 세션 키 반환 (WASM에 전달용)
   */
  getSessionKey(): Uint8Array {
    if (!this.sessionKey) {
      throw new Error('Session key not derived');
    }
    return this.sessionKey;
  }

  /**
   * 랜덤 프리픽스 생성 (Nonce용)
   */
  generateRandomPrefix(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(8));
  }

  /**
   * 키 확인 메시지 생성 (HMAC)
   */
  async createKeyConfirmation(): Promise<string> {
    if (!this.sessionKey) {
      throw new Error('Session key not derived');
    }

    const hmacKey = await crypto.subtle.importKey(
      'raw',
      this.sessionKey.buffer as ArrayBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const confirmation = await crypto.subtle.sign(
      'HMAC',
      hmacKey,
      new TextEncoder().encode('KEY_CONFIRM')
    );

    return this.arrayBufferToBase64(confirmation);
  }

  /**
   * 키 확인 검증
   */
  async verifyKeyConfirmation(confirmationBase64: string): Promise<boolean> {
    if (!this.sessionKey) {
      throw new Error('Session key not derived');
    }

    const hmacKey = await crypto.subtle.importKey(
      'raw',
      this.sessionKey.buffer as ArrayBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const confirmation = this.base64ToUint8Array(confirmationBase64);

    return crypto.subtle.verify(
      'HMAC',
      hmacKey,
      confirmation.buffer as ArrayBuffer,
      new TextEncoder().encode('KEY_CONFIRM')
    );
  }

  /**
   * 암호화 초기화 메시지 생성 (Sender → Receiver)
   */
  createInitMessage(): CryptoHandshakeMessage {
    return {
      type: 'CRYPTO_INIT',
      version: CRYPTO_VERSION,
      algorithms: SUPPORTED_ALGORITHMS,
    };
  }

  /**
   * 공개키 메시지 생성
   */
  async createPublicKeyMessage(): Promise<CryptoHandshakeMessage> {
    const publicKey = await this.generateKeyPair();
    
    const message: CryptoHandshakeMessage = {
      type: 'CRYPTO_PUBLIC_KEY',
      publicKey,
    };

    // Initiator는 salt도 포함
    if (this.isInitiator || !this.salt) {
      message.salt = this.generateSalt();
    }

    return message;
  }

  /**
   * 키 확인 메시지 생성
   */
  async createKeyConfirmMessage(): Promise<CryptoHandshakeMessage> {
    const confirmation = await this.createKeyConfirmation();
    return {
      type: 'CRYPTO_KEY_CONFIRM',
      confirmation,
    };
  }

  /**
   * 암호화 준비 완료 메시지
   */
  createReadyMessage(): CryptoHandshakeMessage {
    return {
      type: 'CRYPTO_READY',
    };
  }

  /**
   * 암호화 활성화 여부
   */
  isReady(): boolean {
    return this.sessionKey !== null;
  }

  /**
   * Initiator 여부
   */
  isSessionInitiator(): boolean {
    return this.isInitiator;
  }

  /**
   * 리소스 정리
   */
  cleanup(): void {
    this.keyPair = null;
    this.peerPublicKey = null;
    this.salt = null;
    
    if (this.sessionKey) {
      this.sessionKey.fill(0);
      this.sessionKey = null;
    }
    
    console.log('[CryptoService] Cleaned up');
  }

  // ============ Utility Methods ============

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}

// 싱글톤 인스턴스
export const cryptoService = new CryptoService();
