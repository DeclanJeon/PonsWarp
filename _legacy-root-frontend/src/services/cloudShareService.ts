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
  uploadUrl?: string;
  multipart?: CloudMultipartUploadTarget;
}

export interface CloudMultipartUploadTarget {
  uploadId: string;
  partSize: number;
  parts: CloudMultipartUploadPartTarget[];
}

export interface CloudMultipartUploadPartTarget {
  partNumber: number;
  offset: number;
  size: number;
  uploadUrl: string;
}

export interface CompletedMultipartUpload {
  fileId: string;
  uploadId: string;
  parts: CompletedMultipartUploadPart[];
}

export interface CompletedMultipartUploadPart {
  partNumber: number;
  eTag: string;
}

export interface AbortMultipartUpload {
  fileId: string;
  uploadId: string;
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
  password?: string;
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
  requiresPassword: boolean;
  downloadSessionToken?: string;
  files: PublicCloudFile[];
}

export interface CloudShareAccessOptions {
  password?: string;
  downloadSessionToken?: string;
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

export type PaymentProvider = 'lemonSqueezy' | 'payPal';

export interface PaymentProviderStatus {
  provider: PaymentProvider;
  label: string;
  available: boolean;
  default: boolean;
}

export interface CloudPlansResponse {
  directP2p: DirectP2PPlan;
  free: CloudPlanLimit;
  passes: DropPassPlan[];
  pro: ProCloudPlan;
  checkoutEnabled: boolean;
  paymentProviders: PaymentProviderStatus[];
}

export interface BillingCheckoutResponse {
  checkoutUrl: string;
  checkoutId?: string;
  provider?: PaymentProvider;
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
  returnUrl: string,
  provider?: PaymentProvider
): Promise<BillingCheckoutResponse> => {
  const response = await fetch(apiPath('/api/billing/checkout'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, sku, returnUrl, provider }),
  });

  return readJsonResponse<BillingCheckoutResponse>(response);
};

export const captureBillingCheckout = async (
  orderId: string
): Promise<BillingCaptureResponse> => {
  const response = await fetch(apiPath('/api/billing/capture'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId }),
  });

  return readJsonResponse<BillingCaptureResponse>(response);
};

export const completeCloudShare = async (
  shareId: string,
  uploadedFileIds: string[],
  multipartUploads: CompletedMultipartUpload[] = []
): Promise<PublicCloudShareResponse> => {
  const response = await fetch(
    apiPath(`/api/cloud-share/${encodeURIComponent(shareId)}/complete`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadedFileIds, multipartUploads }),
    }
  );

  return readJsonResponse<PublicCloudShareResponse>(response);
};

export const abortCloudShareUploads = async (
  shareId: string,
  multipartUploads: AbortMultipartUpload[]
): Promise<void> => {
  if (multipartUploads.length === 0) return;

  const response = await fetch(
    apiPath(`/api/cloud-share/${encodeURIComponent(shareId)}/abort`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ multipartUploads }),
    }
  );

  await readJsonResponse<{ ok: boolean }>(response);
};

export const getCloudShare = async (
  shareId: string,
  options: CloudShareAccessOptions = {}
): Promise<PublicCloudShareResponse> => {
  const url = apiPath(`/api/cloud-share/${encodeURIComponent(shareId)}`);
  const hasAccessPayload = Boolean(
    options.password || options.downloadSessionToken
  );
  const response = hasAccessPayload
    ? await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      })
    : await fetch(url);

  return readJsonResponse<PublicCloudShareResponse>(response);
};

export const getCloudDownloadUrl = (
  shareId: string,
  fileId: string,
  downloadSessionToken?: string
) => {
  const path = apiPath(
    `/api/cloud-share/${encodeURIComponent(shareId)}/files/${encodeURIComponent(
      fileId
    )}/download`
  );
  if (!downloadSessionToken) return path;
  const params = new URLSearchParams({ token: downloadSessionToken });
  return `${path}?${params.toString()}`;
};

export const uploadCloudFile = async (
  target: CloudUploadTarget,
  file: File,
  onProgress: (progress: UploadProgress) => void
): Promise<CompletedMultipartUpload | undefined> => {
  if (target.multipart) {
    const completedParts: CompletedMultipartUploadPart[] = [];
    const partLoaded = new Map<number, number>();
    let nextPartIndex = 0;

    const emitMultipartProgress = () => {
      const loaded = Array.from(partLoaded.values()).reduce(
        (total, value) => total + value,
        0
      );
      onProgress({ loaded, total: file.size });
    };

    const uploadPartWorker = async () => {
      for (;;) {
        const part = target.multipart?.parts[nextPartIndex];
        nextPartIndex += 1;
        if (!part) return;

        const blob = file.slice(part.offset, part.offset + part.size);
        const eTag = await uploadBlobPartWithRetry(
          part.uploadUrl,
          blob,
          progressEvent => {
            partLoaded.set(part.partNumber, progressEvent.loaded);
            emitMultipartProgress();
          },
          () => {
            partLoaded.set(part.partNumber, 0);
            emitMultipartProgress();
          }
        );
        partLoaded.set(part.partNumber, part.size);
        emitMultipartProgress();
        completedParts.push({ partNumber: part.partNumber, eTag });
      }
    };

    const partWorkerCount = Math.min(
      MULTIPART_PART_CONCURRENCY,
      target.multipart.parts.length
    );
    await Promise.all(
      Array.from({ length: partWorkerCount }, uploadPartWorker)
    );

    completedParts.sort((left, right) => left.partNumber - right.partNumber);

    if (completedParts.length !== target.multipart.parts.length) {
      throw new Error('Multipart upload did not complete every part');
    }

    return {
      fileId: target.id,
      uploadId: target.multipart.uploadId,
      parts: completedParts,
    };
  }

  if (!target.uploadUrl) {
    throw new Error('Cloud upload target is missing an upload URL');
  }
  await uploadBlobWithRetry(target.uploadUrl, file, onProgress);
  return undefined;
};

const MULTIPART_PART_CONCURRENCY = 3;
const UPLOAD_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 600;

const wait = (delayMs: number) =>
  new Promise(resolve => setTimeout(resolve, delayMs));

const uploadBlobWithRetry = async (
  uploadUrl: string,
  blob: Blob,
  onProgress: (progress: UploadProgress) => void
): Promise<void> => {
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      await uploadBlob(uploadUrl, blob, onProgress);
      return;
    } catch (error) {
      if (attempt === UPLOAD_MAX_ATTEMPTS) throw error;
      onProgress({ loaded: 0, total: blob.size });
      await wait(RETRY_BASE_DELAY_MS * attempt);
    }
  }
};

const uploadBlobPartWithRetry = async (
  uploadUrl: string,
  blob: Blob,
  onProgress: (progress: UploadProgress) => void,
  onRetry: () => void
): Promise<string> => {
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      return await uploadBlobPart(uploadUrl, blob, onProgress);
    } catch (error) {
      if (attempt === UPLOAD_MAX_ATTEMPTS) throw error;
      onRetry();
      await wait(RETRY_BASE_DELAY_MS * attempt);
    }
  }

  throw new Error('Multipart upload failed');
};

const uploadBlob = (
  uploadUrl: string,
  blob: Blob,
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
        onProgress({ loaded: blob.size, total: blob.size });
        resolve();
        return;
      }
      reject(new Error(`Upload failed with HTTP ${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(blob);
  });

const uploadBlobPart = (
  uploadUrl: string,
  blob: Blob,
  onProgress: (progress: UploadProgress) => void
): Promise<string> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);

    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      onProgress({ loaded: event.loaded, total: event.total });
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const eTag = xhr.getResponseHeader('ETag');
        if (!eTag) {
          reject(
            new Error(
              'Multipart upload part completed but ETag was not exposed by storage CORS'
            )
          );
          return;
        }
        onProgress({ loaded: blob.size, total: blob.size });
        resolve(eTag);
        return;
      }
      reject(new Error(`Upload failed with HTTP ${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(blob);
  });

const readJsonResponse = async <T>(response: Response): Promise<T> => {
  let payload: { error?: string } | null = null;
  try {
    payload = (await response.json()) as { error?: string };
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
