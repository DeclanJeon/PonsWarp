/**
 * OPFS 정리 유틸리티
 * 오래된 전송 디렉토리를 자동으로 삭제하여 공간 확보
 */

export interface StorageInfo {
  quota: number;
  usage: number;
  available: number;
  quotaMB: string;
  usageMB: string;
  availableMB: string;
  usagePercent: number;
}

/**
 * 현재 OPFS 사용량 조회
 */
export async function getStorageInfo(): Promise<StorageInfo> {
  if (!navigator.storage || !navigator.storage.estimate) {
    throw new Error('Storage API not supported');
  }

  const estimate = await navigator.storage.estimate();
  const quota = estimate.quota || 0;
  const usage = estimate.usage || 0;
  const available = quota - usage;

  return {
    quota,
    usage,
    available,
    quotaMB: (quota / (1024 * 1024)).toFixed(2),
    usageMB: (usage / (1024 * 1024)).toFixed(2),
    availableMB: (available / (1024 * 1024)).toFixed(2),
    usagePercent: quota > 0 ? (usage / quota) * 100 : 0,
  };
}

/**
 * 오래된 전송 디렉토리 삭제
 * @param maxAgeHours 삭제할 디렉토리의 최대 나이 (시간 단위, 기본 24시간)
 */
export async function cleanupOldTransfers(maxAgeHours: number = 24): Promise<number> {
  try {
    const root = await navigator.storage.getDirectory();
    let deletedCount = 0;
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

    // @ts-ignore - values() 메서드는 실험적 기능
    for await (const entry of root.values()) {
      if (entry.kind === 'directory') {
        try {
          // 디렉토리 이름이 transfer-로 시작하는 경우만 처리
          if (entry.name.startsWith('transfer-')) {
            const dirHandle = await root.getDirectoryHandle(entry.name);
            
            // 디렉토리 내 파일의 수정 시간 확인
            let oldestTime = now;
            // @ts-ignore
            for await (const fileEntry of dirHandle.values()) {
              if (fileEntry.kind === 'file') {
                const fileHandle = await dirHandle.getFileHandle(fileEntry.name);
                const file = await fileHandle.getFile();
                if (file.lastModified < oldestTime) {
                  oldestTime = file.lastModified;
                }
              }
            }

            // 오래된 디렉토리 삭제
            if (now - oldestTime > maxAgeMs) {
              await root.removeEntry(entry.name, { recursive: true });
              deletedCount++;
              console.log(`[OPFS Cleanup] Deleted old transfer: ${entry.name}`);
            }
          }
        } catch (error) {
          console.warn(`[OPFS Cleanup] Failed to process directory ${entry.name}:`, error);
        }
      }
    }

    console.log(`[OPFS Cleanup] Deleted ${deletedCount} old transfer(s)`);
    return deletedCount;
  } catch (error) {
    console.error('[OPFS Cleanup] Cleanup failed:', error);
    return 0;
  }
}

/**
 * 모든 전송 디렉토리 삭제 (강제 정리)
 */
export async function clearAllTransfers(): Promise<number> {
  try {
    const root = await navigator.storage.getDirectory();
    let deletedCount = 0;

    // @ts-ignore
    for await (const entry of root.values()) {
      if (entry.kind === 'directory' && entry.name.startsWith('transfer-')) {
        try {
          await root.removeEntry(entry.name, { recursive: true });
          deletedCount++;
          console.log(`[OPFS Cleanup] Deleted transfer: ${entry.name}`);
        } catch (error) {
          console.warn(`[OPFS Cleanup] Failed to delete ${entry.name}:`, error);
        }
      }
    }

    console.log(`[OPFS Cleanup] Cleared ${deletedCount} transfer(s)`);
    return deletedCount;
  } catch (error) {
    console.error('[OPFS Cleanup] Clear all failed:', error);
    return 0;
  }
}

/**
 * 공간 확보가 필요한지 확인
 * @param requiredBytes 필요한 바이트 수
 */
export async function needsCleanup(requiredBytes: number): Promise<boolean> {
  const info = await getStorageInfo();
  return info.available < requiredBytes;
}
