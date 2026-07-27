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

export interface AdminOperationsResponse {
  users: AdminUserListItem[];
  subscriptions: AdminSubscriptionListItem[];
  dropPasses: AdminDropPassListItem[];
  cloudShares: AdminCloudShareListItem[];
  billingEvents: AdminBillingEventListItem[];
}

export interface AdminUserListItem {
  id: string;
  email: string;
  name?: string;
  plan: string;
  createdAt: number;
  lastLoginAt?: number;
}

export interface AdminSubscriptionListItem {
  id: string;
  email: string;
  status: string;
  providerSubscriptionId?: string;
  currentPeriodEnd?: number;
  updatedAt: number;
}

export interface AdminDropPassListItem {
  id: string;
  email?: string;
  sku: string;
  status: string;
  remainingUses: number;
  maxTotalBytes: number;
  retentionSeconds: number;
  createdAt: number;
  expiresAt?: number;
}

export interface AdminCloudShareListItem {
  id: string;
  ownerEmail?: string;
  rootName: string;
  totalSize: number;
  totalFiles: number;
  completed: boolean;
  downloadCount: number;
  downloadLimit?: number;
  createdAt: number;
  expiresAt: number;
  deletedAt?: number;
}

export interface AdminBillingEventListItem {
  provider: string;
  id: string;
  eventType: string;
  createdAt: number;
  processedAt: number;
}

export const getAdminMe = async (): Promise<AdminMeResponse> => {
  const response = await fetch(apiPath('/api/admin/me'), {
    credentials: 'include',
  });
  return readJsonResponse<AdminMeResponse>(response);
};

export const getAdminOverview = async (): Promise<AdminOverviewResponse> => {
  const response = await fetch(apiPath('/api/admin/overview'), {
    credentials: 'include',
  });
  return readJsonResponse<AdminOverviewResponse>(response);
};

export const getAdminOperations =
  async (): Promise<AdminOperationsResponse> => {
    const response = await fetch(apiPath('/api/admin/operations'), {
      credentials: 'include',
    });
    return readJsonResponse<AdminOperationsResponse>(response);
  };

const readJsonResponse = async <T>(response: Response): Promise<T> => {
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
