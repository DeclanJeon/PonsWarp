// 에러 핸들링 및 폴백 메커니즘
export enum ErrorType {
  TURN_CONNECTION_FAILED = 'TURN_CONNECTION_FAILED',
  TURN_CREDENTIALS_EXPIRED = 'TURN_CREDENTIALS_EXPIRED',
  TURN_SERVER_UNAVAILABLE = 'TURN_SERVER_UNAVAILABLE',
  STUN_CONNECTION_FAILED = 'STUN_CONNECTION_FAILED',
  PEER_CONNECTION_FAILED = 'PEER_CONNECTION_FAILED',
  NETWORK_UNAVAILABLE = 'NETWORK_UNAVAILABLE',
  SIGNALLING_CONNECTION_FAILED = 'SIGNALLING_CONNECTION_FAILED',
  FILE_TRANSFER_ERROR = 'FILE_TRANSFER_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export interface ErrorInfo {
  type: ErrorType;
  severity: ErrorSeverity;
  message: string;
  originalError?: any;
  timestamp: number;
  retryCount: number;
  maxRetries: number;
  context?: Record<string, any>;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  retryableErrors: ErrorType[];
}

class ErrorHandler {
  private errors: ErrorInfo[] = [];
  private retryConfigs: Map<ErrorType, RetryConfig> = new Map();
  private errorCallbacks: Map<ErrorType, ((error: ErrorInfo) => void)[]> =
    new Map();

  constructor() {
    this.initializeRetryConfigs();
  }

  private initializeRetryConfigs() {
    // TURN 연결 실패 - 3번 재시도, 지수 백오프
    this.retryConfigs.set(ErrorType.TURN_CONNECTION_FAILED, {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffMultiplier: 2,
      retryableErrors: [
        ErrorType.TURN_CONNECTION_FAILED,
        ErrorType.TURN_SERVER_UNAVAILABLE,
      ],
    });

    // TURN 자격 증명 만료 - 2번 재시도, 짧은 지연
    this.retryConfigs.set(ErrorType.TURN_CREDENTIALS_EXPIRED, {
      maxRetries: 2,
      baseDelay: 500,
      maxDelay: 2000,
      backoffMultiplier: 1.5,
      retryableErrors: [ErrorType.TURN_CREDENTIALS_EXPIRED],
    });

    // STUN 연결 실패 - 2번 재시도
    this.retryConfigs.set(ErrorType.STUN_CONNECTION_FAILED, {
      maxRetries: 2,
      baseDelay: 2000,
      maxDelay: 8000,
      backoffMultiplier: 2,
      retryableErrors: [ErrorType.STUN_CONNECTION_FAILED],
    });

    // 시그널링 연결 실패 - 5번 재시도
    this.retryConfigs.set(ErrorType.SIGNALLING_CONNECTION_FAILED, {
      maxRetries: 5,
      baseDelay: 1000,
      maxDelay: 15000,
      backoffMultiplier: 1.8,
      retryableErrors: [ErrorType.SIGNALLING_CONNECTION_FAILED],
    });

    // P2P 연결 실패 - 3번 재시도
    this.retryConfigs.set(ErrorType.PEER_CONNECTION_FAILED, {
      maxRetries: 3,
      baseDelay: 1500,
      maxDelay: 12000,
      backoffMultiplier: 2,
      retryableErrors: [ErrorType.PEER_CONNECTION_FAILED],
    });
  }

  // 에러 분류 및 생성
  public classifyError(error: any, context?: Record<string, any>): ErrorInfo {
    const timestamp = Date.now();
    let errorType: ErrorType;
    let severity: ErrorSeverity;

    // 에러 타입 분류
    if (error.message) {
      const message = error.message.toLowerCase();

      if (message.includes('turn') || message.includes('relay')) {
        if (
          message.includes('credential') ||
          message.includes('unauthorized') ||
          message.includes('401')
        ) {
          errorType = ErrorType.TURN_CREDENTIALS_EXPIRED;
          severity = ErrorSeverity.HIGH;
        } else if (
          message.includes('unavailable') ||
          message.includes('timeout') ||
          message.includes('connection')
        ) {
          errorType = ErrorType.TURN_SERVER_UNAVAILABLE;
          severity = ErrorSeverity.MEDIUM;
        } else {
          errorType = ErrorType.TURN_CONNECTION_FAILED;
          severity = ErrorSeverity.HIGH;
        }
      } else if (message.includes('stun')) {
        errorType = ErrorType.STUN_CONNECTION_FAILED;
        severity = ErrorSeverity.MEDIUM;
      } else if (
        message.includes('peer') ||
        message.includes('webrtc') ||
        message.includes('ice failed')
      ) {
        errorType = ErrorType.PEER_CONNECTION_FAILED;
        severity = ErrorSeverity.HIGH;
      } else if (
        message.includes('signaling') ||
        message.includes('socket') ||
        message.includes('connection')
      ) {
        errorType = ErrorType.SIGNALLING_CONNECTION_FAILED;
        severity = ErrorSeverity.HIGH;
      } else if (
        message.includes('network') ||
        message.includes('offline') ||
        message.includes('dns')
      ) {
        errorType = ErrorType.NETWORK_UNAVAILABLE;
        severity = ErrorSeverity.CRITICAL;
      } else if (
        message.includes('file') ||
        message.includes('transfer') ||
        message.includes('chunk')
      ) {
        errorType = ErrorType.FILE_TRANSFER_ERROR;
        severity = ErrorSeverity.MEDIUM;
      } else {
        errorType = ErrorType.UNKNOWN_ERROR;
        severity = ErrorSeverity.LOW;
      }
    } else {
      errorType = ErrorType.UNKNOWN_ERROR;
      severity = ErrorSeverity.LOW;
    }

    const errorInfo: ErrorInfo = {
      type: errorType,
      severity,
      message: error.message || 'Unknown error occurred',
      originalError: error,
      timestamp,
      retryCount: 0,
      maxRetries: this.retryConfigs.get(errorType)?.maxRetries || 0,
      context,
    };

    this.errors.push(errorInfo);
    this.logError(errorInfo);
    this.triggerErrorCallbacks(errorType, errorInfo);

    return errorInfo;
  }

  // 재시도 가능 여부 확인
  public canRetry(errorInfo: ErrorInfo): boolean {
    const config = this.retryConfigs.get(errorInfo.type);
    if (!config) return false;

    return (
      errorInfo.retryCount < config.maxRetries &&
      config.retryableErrors.includes(errorInfo.type)
    );
  }

  // 재시도 지연 시간 계산
  public calculateRetryDelay(errorInfo: ErrorInfo): number {
    const config = this.retryConfigs.get(errorInfo.type);
    if (!config) return 1000;

    const delay =
      config.baseDelay *
      Math.pow(config.backoffMultiplier, errorInfo.retryCount);
    return Math.min(delay, config.maxDelay);
  }

  // 재시도 실행
  public async retryWithError<T>(
    errorInfo: ErrorInfo,
    retryFunction: () => Promise<T>,
    context?: Record<string, any>
  ): Promise<{ success: boolean; result?: T; error?: ErrorInfo }> {
    if (!this.canRetry(errorInfo)) {
      return { success: false, error: errorInfo };
    }

    errorInfo.retryCount++;
    errorInfo.context = { ...errorInfo.context, ...context };

    const delay = this.calculateRetryDelay(errorInfo);
    console.log(
      `[ErrorHandler] Retrying ${errorInfo.type} (attempt ${errorInfo.retryCount}/${errorInfo.maxRetries}) after ${delay}ms`
    );

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      const result = await retryFunction();
      console.log(`[ErrorHandler] Retry successful for ${errorInfo.type}`);
      return { success: true, result };
    } catch (error) {
      const newErrorInfo = this.classifyError(error, context);
      return { success: false, error: newErrorInfo };
    }
  }

  // 자동 재시도 래퍼
  public async executeWithRetry<T>(
    operation: () => Promise<T>,
    errorType: ErrorType,
    context?: Record<string, any>
  ): Promise<{ success: boolean; result?: T; error?: ErrorInfo }> {
    try {
      const result = await operation();
      return { success: true, result };
    } catch (error) {
      const errorInfo = this.classifyError(error, context);

      if (errorInfo.type !== errorType) {
        console.warn(
          `[ErrorHandler] Expected ${errorType} but got ${errorInfo.type}`
        );
      }

      return await this.retryWithError(errorInfo, operation, context);
    }
  }

  // 에러 콜백 등록
  public onError(
    errorType: ErrorType,
    callback: (error: ErrorInfo) => void
  ): void {
    if (!this.errorCallbacks.has(errorType)) {
      this.errorCallbacks.set(errorType, []);
    }
    this.errorCallbacks.get(errorType)!.push(callback);
  }

  // 에러 콜백 제거
  public offError(
    errorType: ErrorType,
    callback: (error: ErrorInfo) => void
  ): void {
    const callbacks = this.errorCallbacks.get(errorType);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  // 에러 콜백 트리거
  private triggerErrorCallbacks(
    errorType: ErrorType,
    errorInfo: ErrorInfo
  ): void {
    const callbacks = this.errorCallbacks.get(errorType);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(errorInfo);
        } catch (callbackError) {
          console.error(
            '[ErrorHandler] Error in error callback:',
            callbackError
          );
        }
      });
    }
  }

  // 에러 로깅
  private logError(errorInfo: ErrorInfo): void {
    const logLevel = this.getLogLevel(errorInfo.severity);
    const logMessage = `[${errorInfo.severity.toUpperCase()}] ${errorInfo.type}: ${errorInfo.message}`;

    const contextStr = errorInfo.context
      ? ` | Context: ${JSON.stringify(errorInfo.context)}`
      : '';
    const retryStr = ` | Retry: ${errorInfo.retryCount}/${errorInfo.maxRetries}`;

    console.log(`${logMessage}${contextStr}${retryStr}`);

    if (errorInfo.originalError && errorInfo.originalError.stack) {
      console.log('Stack trace:', errorInfo.originalError.stack);
    }
  }

  private getLogLevel(severity: ErrorSeverity): string {
    switch (severity) {
      case ErrorSeverity.CRITICAL:
        return 'CRITICAL';
      case ErrorSeverity.HIGH:
        return 'ERROR';
      case ErrorSeverity.MEDIUM:
        return 'WARN';
      case ErrorSeverity.LOW:
        return 'INFO';
      default:
        return 'INFO';
    }
  }

  // 에러 통계
  public getErrorStats(): {
    totalErrors: number;
    errorsByType: Record<ErrorType, number>;
    errorsBySeverity: Record<ErrorSeverity, number>;
    recentErrors: ErrorInfo[];
  } {
    const errorsByType: Record<ErrorType, number> = {} as any;
    const errorsBySeverity: Record<ErrorSeverity, number> = {} as any;

    this.errors.forEach(error => {
      errorsByType[error.type] = (errorsByType[error.type] || 0) + 1;
      errorsBySeverity[error.severity] =
        (errorsBySeverity[error.severity] || 0) + 1;
    });

    return {
      totalErrors: this.errors.length,
      errorsByType,
      errorsBySeverity,
      recentErrors: this.errors.slice(-10), // 최근 10개 에러
    };
  }

  // 에러 기록 정리
  public clearErrors(olderThanMs: number = 3600000): void {
    // 기본 1시간
    const cutoffTime = Date.now() - olderThanMs;
    this.errors = this.errors.filter(error => error.timestamp > cutoffTime);
    console.log(
      `[ErrorHandler] Cleared ${this.errors.length} old error records`
    );
  }

  // 네트워크 상태 확인
  public async checkNetworkConnectivity(): Promise<{
    online: boolean;
    turnReachable: boolean;
    stunReachable: boolean;
    signalingReachable: boolean;
  }> {
    const results = {
      online: navigator.onLine,
      turnReachable: false,
      stunReachable: false,
      signalingReachable: false,
    };

    // TURN 서버 연결 확인
    try {
      const turnController = new AbortController();
      const turnTimeout = setTimeout(() => turnController.abort(), 5000);

      const turnResponse = await fetch('/api/turn-status', {
        method: 'GET',
        signal: turnController.signal,
      });
      clearTimeout(turnTimeout);
      results.turnReachable = turnResponse.ok;
    } catch (error) {
      console.warn('[ErrorHandler] TURN server unreachable:', error);
    }

    // STUN 서버 연결 확인 (간단한 ping)
    try {
      const stunController = new AbortController();
      const stunTimeout = setTimeout(() => stunController.abort(), 3000);

      const stunResponse = await fetch('https://stun.l.google.com:19302', {
        method: 'GET',
        mode: 'no-cors',
        signal: stunController.signal,
      });
      clearTimeout(stunTimeout);
      results.stunReachable = true; // CORS 에러가 발생해도 서버는 살아있음
    } catch (error) {
      console.warn('[ErrorHandler] STUN server unreachable:', error);
    }

    // 시그널링 서버 연결 확인
    try {
      const signalingController = new AbortController();
      const signalingTimeout = setTimeout(
        () => signalingController.abort(),
        3000
      );

      const signalingResponse = await fetch('/health', {
        method: 'GET',
        signal: signalingController.signal,
      });
      clearTimeout(signalingTimeout);
      results.signalingReachable = signalingResponse.ok;
    } catch (error) {
      console.warn('[ErrorHandler] Signaling server unreachable:', error);
    }

    return results;
  }

  // 폴백 전략 제안
  public suggestFallback(errorInfo: ErrorInfo): string[] {
    const suggestions: string[] = [];

    switch (errorInfo.type) {
      case ErrorType.TURN_CONNECTION_FAILED:
      case ErrorType.TURN_SERVER_UNAVAILABLE:
        suggestions.push('Try using a different network connection');
        suggestions.push('Check if firewall is blocking TURN traffic');
        suggestions.push('Wait a moment and try again');
        break;

      case ErrorType.TURN_CREDENTIALS_EXPIRED:
        suggestions.push('Refresh TURN credentials');
        suggestions.push('Reconnect to signaling server');
        break;

      case ErrorType.STUN_CONNECTION_FAILED:
        suggestions.push('Check your internet connection');
        suggestions.push('Try using TURN server as fallback');
        break;

      case ErrorType.PEER_CONNECTION_FAILED:
        suggestions.push('Try refreshing the page');
        suggestions.push('Check if both peers have stable internet');
        suggestions.push('Try using TURN server for NAT traversal');
        break;

      case ErrorType.SIGNALLING_CONNECTION_FAILED:
        suggestions.push('Check signaling server status');
        suggestions.push('Refresh the page and try again');
        suggestions.push('Try a different browser');
        break;

      case ErrorType.NETWORK_UNAVAILABLE:
        suggestions.push('Check your internet connection');
        suggestions.push('Try switching to a different network');
        suggestions.push('Wait for network to be restored');
        break;

      case ErrorType.FILE_TRANSFER_ERROR:
        suggestions.push('Try transferring the file again');
        suggestions.push('Check if file is corrupted');
        suggestions.push('Try using a smaller file for testing');
        break;

      default:
        suggestions.push('Try refreshing the page');
        suggestions.push('Check browser console for details');
        suggestions.push('Contact support if problem persists');
    }

    return suggestions;
  }
}

export const errorHandler = new ErrorHandler();
