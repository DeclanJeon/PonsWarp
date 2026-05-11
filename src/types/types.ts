export enum AppMode {
  INTRO = 'INTRO',
  SELECTION = 'SELECTION',
  SENDER = 'SENDER',
  RECEIVER = 'RECEIVER',
  CLOUD_SENDER = 'CLOUD_SENDER',
  CLOUD_RECEIVER = 'CLOUD_RECEIVER',
  TRANSFERRING = 'TRANSFERRING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export interface FileNode {
  id: number; // 전송 시 식별할 index (0부터 시작)
  name: string; // 파일명
  path: string; // 상대 경로 (폴더 구조 포함)
  size: number; // 바이트 크기
  type: string; // MIME type
  lastModified: number;
  checksum?: string; // 💡 [패치] SHA-256 Checksum 추가
}

export interface TransferManifest {
  transferId: string;
  totalSize: number;
  totalFiles: number;
  rootName: string; // 최상위 폴더명 또는 대표 파일명
  files: FileNode[];
  isFolder: boolean;
  isSizeEstimated?: boolean; // 🚨 [추가] ZIP 모드일 경우 정확한 크기를 알 수 없음
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

// 🚀 [추가] 네트워크 상태 관련 타입
export interface NetworkStatus {
  bufferedAmount: number;
  maxBufferedAmount: number;
  averageSpeed: number; // bytes per second
}

export interface WorkerMessage {
  type:
    | 'CHUNK'
    | 'COMPLETE'
    | 'ERROR'
    | 'INIT_OPFS'
    | 'MANIFEST'
    | 'UPDATE_NETWORK'
    | 'NETWORK_UPDATE';
  payload?: any;
}

export interface WorkerCommand {
  command: 'START_READ' | 'NEXT_CHUNK' | 'INIT_WRITE' | 'WRITE_CHUNK';
  payload?: any;
}
