export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return fallback;
}

export function getErrorName(error: unknown): string | null {
  if (error instanceof DOMException && error.name) {
    return error.name;
  }
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return null;
}
