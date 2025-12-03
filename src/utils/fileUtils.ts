import { FileNode, TransferManifest } from '../types/types';
import { ScannedFile } from './fileScanner';

// ScannedFile[] -> TransferManifest 변환 (새로운 방식)
export const createManifest = (
  scannedFiles: ScannedFile[]
): { manifest: TransferManifest; files: File[] } => {
  const fileNodes: FileNode[] = [];
  let totalSize = 0;
  const rawFiles: File[] = [];

  scannedFiles.forEach((item, index) => {
    totalSize += item.file.size;
    rawFiles.push(item.file);

    fileNodes.push({
      id: index,
      name: item.file.name,
      path: item.path, // 스캐너가 정제한 전체 경로
      size: item.file.size,
      type: item.file.type || 'application/octet-stream',
      lastModified: item.file.lastModified,
    });
  });

  // Root Name 및 폴더 여부 판단
  let rootName = 'Transfer';
  let isFolder = false;

  if (scannedFiles.length > 0) {
    const firstPath = scannedFiles[0].path;
    if (firstPath.includes('/')) {
      // 경로에 슬래시가 있으면 폴더 구조임
      rootName = firstPath.split('/')[0];
      isFolder = true;
    } else if (scannedFiles.length > 1) {
      // 파일이 여러 개지만 최상위 경로가 없으면 'Multi-Files'
      rootName = `Files (${scannedFiles.length})`;
      isFolder = true; // ZIP으로 묶어야 함
    } else {
      // 단일 파일
      rootName = scannedFiles[0].file.name;
      isFolder = false;
    }
  }

  const manifest: TransferManifest = {
    transferId: `warp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    totalSize,
    totalFiles: scannedFiles.length,
    rootName,
    files: fileNodes,
    isFolder,
    // 🚨 [추가] ZIP 모드일 경우 정확한 크기를 알 수 없음
    // Receiver는 이 플래그를 보고 StreamSaver 설정을 조정할 수 있음
    isSizeEstimated: isFolder || scannedFiles.length > 1,
  };

  return { manifest, files: rawFiles };
};

export const formatBytes = (bytes: number, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};
