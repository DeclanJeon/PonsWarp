import { ScannedFile } from '../utils/fileScanner';

const API_BASE = (import.meta.env.VITE_CLOUD_API_BASE_URL || '').replace(
  /\/$/,
  ''
);

export interface CloudUploadTarget {
  id: string;
  name: string;
  path: string;
  size: number;
  uploadUrl: string;
}

export interface CreateCloudShareResponse {
  shareId: string;
  shareUrl: string;
  expiresAt: number;
  uploadUrlTtlSeconds: number;
  files: CloudUploadTarget[];
}

export interface CreateCloudShareOptions {
  entitlementToken?: string;
  retentionSeconds?: number;
  downloadLimit?: number;
}

export interface PublicCloudFile {
  id: string;
  name: string;
  path: string;
  size: number;
  contentType: string;
  lastModified?: number;
}

export interface PublicCloudShareResponse {
  shareId: string;
  rootName: string;
  totalSize: number;
  totalFiles: number;
  createdAt: number;
  expiresAt: number;
  secondsUntilExpiry: number;
  completed: boolean;
  files: PublicCloudFile[];
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface DirectP2PPlan {
  label: string;
  unlimited: boolean;
  priceKrw: number;
}

export interface CloudPlanLimit {
  sku: string;
  label: string;
  priceKrw: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  retentionSeconds: number;
  downloadLimit?: number;
  available: boolean;
}

export type DropPassPlan = CloudPlanLimit;

export interface ProCloudPlan extends CloudPlanLimit {
  monthlyQuotaBytes: number;
  concurrentStorageBytes: number;
}

export interface CloudPlansResponse {
  directP2p: DirectP2PPlan;
  free: CloudPlanLimit;
  passes: DropPassPlan[];
  pro: ProCloudPlan;
  checkoutEnabled: boolean;
}

export interface BillingCheckoutResponse {
  checkoutUrl: string;
}

export interface BillingCaptureResponse {
  entitlementToken: string;
}

const apiPath = (path: string) => `${API_BASE}${path}`;

export const getCloudPlans = async (): Promise<CloudPlansResponse> => {
  const response = await fetch(apiPath('/api/cloud-plans'));
  return readJsonResponse<CloudPlansResponse>(response);
};

export const createCloudShare = async (
  rootName: string,
  scannedFiles: ScannedFile[],
  options: CreateCloudShareOptions = {}
): Promise<CreateCloudShareResponse> => {
  const response = await fetch(apiPath('/api/cloud-share'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rootName,
      ...options,
      files: scannedFiles.map(item => ({
        name: item.file.name,
        path: item.path,
        size: item.file.size,
        contentType: item.file.type || 'application/octet-stream',
        lastModified: item.file.lastModified,
      })),
    }),
  });

  return readJsonResponse<CreateCloudShareResponse>(response);
};

export const createBillingCheckout = async (
  mode: 'payment' | 'subscription',
  sku: string,
  returnUrl: string
): Promise<BillingCheckoutResponse> => {
  const response = await fetch(apiPath('/api/billing/checkout'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, sku, returnUrl }),
  });

  return readJsonResponse<BillingCheckoutResponse>(response);
};

export const captureBillingCheckout = async (
  orderId: string
): Promise<BillingCaptureResponse> => {
  const response = await fetch(apiPath('/api/billing/capture'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId }),
  });

  return readJsonResponse<BillingCaptureResponse>(response);
};

export const completeCloudShare = async (
  shareId: string,
  uploadedFileIds: string[]
): Promise<PublicCloudShareResponse> => {
  const response = await fetch(
    apiPath(`/api/cloud-share/${encodeURIComponent(shareId)}/complete`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadedFileIds }),
    }
  );

  return readJsonResponse<PublicCloudShareResponse>(response);
};

export const getCloudShare = async (
  shareId: string
): Promise<PublicCloudShareResponse> => {
  const response = await fetch(
    apiPath(`/api/cloud-share/${encodeURIComponent(shareId)}`)
  );

  return readJsonResponse<PublicCloudShareResponse>(response);
};

export const getCloudDownloadUrl = (shareId: string, fileId: string) =>
  apiPath(
    `/api/cloud-share/${encodeURIComponent(shareId)}/files/${encodeURIComponent(
      fileId
    )}/download`
  );

export const uploadCloudFile = (
  uploadUrl: string,
  file: File,
  onProgress: (progress: UploadProgress) => void
): Promise<void> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);

    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      onProgress({ loaded: event.loaded, total: event.total });
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress({ loaded: file.size, total: file.size });
        resolve();
        return;
      }
      reject(new Error(`Upload failed with HTTP ${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(file);
  });

const readJsonResponse = async <T>(response: Response): Promise<T> => {
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(
      payload?.error || `Request failed with HTTP ${response.status}`
    );
  }

  return payload as T;
};
