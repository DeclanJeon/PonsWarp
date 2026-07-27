/**
 * 로그 유틸리티 - 개발/프로덕션 환경에 따라 로그 레벨 제어
 */

// 환경 변수 확인 (Vite는 import.meta.env를 사용)
const isDevelopment = import.meta.env.DEV;
const isProduction = import.meta.env.PROD;

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

// 현재 환경에 따른 로그 레벨 설정
const currentLogLevel = isDevelopment
  ? LogLevel.DEBUG
  : isProduction
    ? LogLevel.ERROR
    : LogLevel.INFO;

/**
 * 로그 출력 함수
 * @param level - 로그 레벨
 * @param tag - 로그 태그 (예: '[WebRTC]', '[Sender]')
 * @param message - 로그 메시지
 * @param data - 추가 데이터 (선택적)
 */
type LogPayload = unknown;
type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error';

function writeConsole(method: ConsoleMethod, args: LogPayload[]) {
  globalThis.console?.[method]?.(...args);
}

export function log(
  level: LogLevel,
  tag: string,
  message: string,
  data?: LogPayload
) {
  // 현재 로그 레벨보다 낮은 레벨은 출력하지 않음
  if (level < currentLogLevel) {
    return;
  }

  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${tag} ${message}`;

  switch (level) {
    case LogLevel.DEBUG:
      writeConsole('debug', [logMessage, data || '']);
      break;
    case LogLevel.INFO:
      writeConsole('info', [logMessage, data || '']);
      break;
    case LogLevel.WARN:
      writeConsole('warn', [logMessage, data || '']);
      break;
    case LogLevel.ERROR:
      writeConsole('error', [logMessage, data || '']);
      break;
  }
}

/**
 * 디버그 로그 (개발 환경에서만 출력)
 */
export function logDebug(tag: string, message: string, data?: LogPayload) {
  log(LogLevel.DEBUG, tag, message, data);
}

/**
 * 정보 로그 (개발 환경에서만 출력)
 */
export function logInfo(tag: string, message: string, data?: LogPayload) {
  log(LogLevel.INFO, tag, message, data);
}

/**
 * 경고 로그 (모든 환경에서 출력)
 */
export function logWarn(tag: string, message: string, data?: LogPayload) {
  log(LogLevel.WARN, tag, message, data);
}

/**
 * 에러 로그 (모든 환경에서 출력)
 */
export function logError(tag: string, message: string, data?: LogPayload) {
  log(LogLevel.ERROR, tag, message, data);
}

/**
 * 프로덕션 환경에서도 출력해야 하는 중요 로그
 */
export function logCritical(tag: string, message: string, data?: LogPayload) {
  // 프로덕션 환경에서도 항상 출력
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${tag} ${message}`;
  writeConsole('error', [logMessage, data || '']);
}

export function debugLog(...args: LogPayload[]) {
  if (LogLevel.DEBUG < currentLogLevel) {
    return;
  }
  writeConsole('debug', args);
}
