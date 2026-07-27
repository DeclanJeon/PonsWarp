const API_BASE = (import.meta.env.VITE_CLOUD_API_BASE_URL || '').replace(
  /\/$/,
  ''
);

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  pictureUrl?: string;
}

export interface AuthState {
  authenticated: boolean;
  user?: AuthUser;
}

const apiPath = (path: string) => `${API_BASE}${path}`;
const anonymousAuthState: AuthState = { authenticated: false };

const isAuthState = (payload: unknown): payload is AuthState => {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  return (
    typeof (payload as { authenticated?: unknown }).authenticated === 'boolean'
  );
};

export const getAuthState = async (): Promise<AuthState> => {
  const response = await fetch(apiPath('/api/auth/me'), {
    credentials: 'include',
  });
  const payload = await readJsonResponse<unknown>(response);
  return isAuthState(payload) ? payload : anonymousAuthState;
};

export const startGoogleSignIn = (returnTo: string) => {
  window.location.href = apiPath(
    `/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`
  );
};

export const logout = async (): Promise<void> => {
  const response = await fetch(apiPath('/api/auth/logout'), {
    method: 'POST',
    credentials: 'include',
  });
  await readJsonResponse(response);
};

const readJsonResponse = async <T = unknown>(
  response: Response
): Promise<T> => {
  let payload: { error?: string } | null = null;
  try {
    payload = (await response.json()) as { error?: string };
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload as T;
};
