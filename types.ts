export enum AppMode {
  INTRO = 'INTRO',
  SELECTION = 'SELECTION',
  SENDER = 'SENDER',
  RECEIVER = 'RECEIVER',
  TRANSFERRING = 'TRANSFERRING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export interface FileNode {
  id: number;       // 전송 시 식별할 index (0부터 시작)
  name: string;     // 파일명
  path: string;     // 상대 경로 (폴더 구조 포함)
  size: number;     // 바이트 크기
  type: string;     // MIME type
  lastModified: number;
}

export interface TransferManifest {
  transferId: string;
  totalSize: number;
  totalFiles: number;
  rootName: string; // 최상위 폴더명 또는 대표 파일명
  files: FileNode[];
  isFolder: boolean;
}

export interface FileMeta {
  name: string;
  size: number;
  type: string;
}

export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  speed: number; // bytes per second
  timeLeft: number; // seconds
  currentFileIndex: number; // 현재 전송 중인 파일 인덱스
}

export interface WorkerMessage {
  type: 'CHUNK' | 'COMPLETE' | 'ERROR' | 'INIT_OPFS' | 'MANIFEST';
  payload?: any;
}

export interface WorkerCommand {
  command: 'START_READ' | 'NEXT_CHUNK' | 'INIT_WRITE' | 'WRITE_CHUNK';
  payload?: any;
}