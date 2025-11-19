import { FileNode, TransferManifest } from '../types';

// FileList -> TransferManifest 변환
export const createManifest = (fileList: FileList | File[]): { manifest: TransferManifest, files: File[] } => {
  const files: File[] = Array.from(fileList);
  const fileNodes: FileNode[] = [];
  let totalSize = 0;

  // 경로 정보가 있는 경우(폴더 업로드)와 없는 경우(단일 파일) 처리
  // webkitRelativePath는 <input webkitdirectory> 사용 시에만 존재
  
  files.forEach((file, index) => {
    totalSize += file.size;
    
    // 경로 정제: webkitRelativePath가 있으면 사용, 없으면 file.name
    // 윈도우의 백슬래시(\)를 슬래시(/)로 통일
    const rawPath = file.webkitRelativePath || file.name;
    const normalizedPath = rawPath.replace(/\\/g, '/');

    fileNodes.push({
      id: index,
      name: file.name,
      path: normalizedPath,
      size: file.size,
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified
    });
  });

  // Root Name 결정 (폴더 업로드면 최상위 폴더명, 아니면 첫 파일명)
  let rootName = 'Transfer';
  let isFolder = false;

  if (files.length > 0) {
    if (files[0].webkitRelativePath) {
      rootName = files[0].webkitRelativePath.split('/')[0];
      isFolder = true;
    } else {
      rootName = files[0].name;
      isFolder = files.length > 1;
    }
  }

  const manifest: TransferManifest = {
    transferId: `warp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    totalSize,
    totalFiles: files.length,
    rootName,
    files: fileNodes,
    isFolder
  };

  return { manifest, files };
};

export const formatBytes = (bytes: number, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};