const API_BASE = (import.meta.env.VITE_CLOUD_API_BASE_URL || '').replace(
  /\/$/,
  ''
);

const apiPath = (path: string) => `${API_BASE}${path}`;

export interface AdminMeResponse {
  authenticated: boolean;
  user: {
    id: string;
    email: string;
  };
  admin: {
    role: string;
    status: string;
  };
}

export interface AdminOverviewResponse {
  totalUsers: number;
  activeSubscriptions: number;
  activeDropPasses: number;
  activeCloudShares: number;
  storedCloudBytes: number;
  billingEvents: number;
}

export const getAdminMe = async (): Promise<AdminMeResponse> => {
  const response = await fetch(apiPath('/api/admin/me'), {
    credentials: 'include',
  });
  return readJsonResponse<AdminMeResponse>(response);
};

export const getAdminOverview =
  async (): Promise<AdminOverviewResponse> => {
    const response = await fetch(apiPath('/api/admin/overview'), {
      credentials: 'include',
    });
    return readJsonResponse<AdminOverviewResponse>(response);
  };

const readJsonResponse = async <T>(response: Response): Promise<T> => {
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
