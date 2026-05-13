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

export const getAuthState = async (): Promise<AuthState> => {
  const response = await fetch(apiPath('/api/auth/me'), {
    credentials: 'include',
  });
  return readJsonResponse<AuthState>(response);
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
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload as T;
};
