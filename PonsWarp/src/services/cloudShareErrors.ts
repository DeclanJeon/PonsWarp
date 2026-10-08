export type CloudShareErrorCode =
  | 'password'
  | 'not-found'
  | 'too-large'
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'unknown';

export interface CloudShareErrorInfo {
  code: CloudShareErrorCode;
  message: string;
}

export class CloudShareApiError extends Error {
  readonly code: CloudShareErrorCode;

  constructor(readonly status: number, readonly detail: string) {
    const info = classifyCloudShareError(new Error(`HTTP ${status}`));
    super(info.message);
    this.name = 'CloudShareApiError';
    this.code = info.code;
  }
}

export function classifyCloudShareError(error: unknown): CloudShareErrorInfo {
  if (error instanceof CloudShareApiError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof TypeError) {
    return {
      code: 'network',
      message: 'Network error. Check your connection.',
    };
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    const statusMatch = msg.match(/http\s+(\d{3})/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : null;

    if (status === 401 || status === 403) {
      return { code: 'password', message: 'Password required or incorrect.' };
    }
    if (status === 404 || status === 410) {
      return { code: 'not-found', message: 'Share not found or expired.' };
    }
    if (status === 413) {
      return { code: 'too-large', message: 'File too large for this plan.' };
    }
    if (status === 429) {
      return { code: 'rate-limit', message: 'Too many requests. Please wait.' };
    }
    if (status && status >= 500) {
      return { code: 'server', message: 'Server error. Try again later.' };
    }
  }
  return { code: 'unknown', message: 'Unexpected error. Please try again.' };
}

