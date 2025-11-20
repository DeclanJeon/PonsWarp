export enum AppMode {
  INTRO = 'INTRO',
  SELECTION = 'SELECTION',
  SENDER = 'SENDER',
  RECEIVER = 'RECEIVER',
  TRANSFERRING = 'TRANSFERRING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

// SenderView 상태 타입
export type SenderStatus = 'IDLE' | 'WAITING' | 'CONNECTING' | 'TRANSFERRING' | 'DONE';

// ReceiverView 상태 타입
export type ReceiverStatus = 'SCANNING' | 'CONNECTING' | 'RECEIVING' | 'DONE' | 'PROCESSING' | 'SAVED' | 'ERROR';

export interface FileNode {
  id: number;
  name: string;
  path: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface TransferManifest {
  transferId: string;
  totalSize: number;
  totalFiles: number;
  rootName: string;
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
  speed: number;
  timeLeft: number;
  currentFileIndex: number;
}

export interface NetworkStatus {
  bufferedAmount: number;
  maxBufferedAmount: number;
  averageSpeed: number;
}

export interface WorkerMessage {
  type: 'CHUNK' | 'COMPLETE' | 'ERROR' | 'INIT_OPFS' | 'MANIFEST' | 'UPDATE_NETWORK' | 'NETWORK_UPDATE';
  payload?: any;
}

export interface WorkerCommand {
  command: 'START_READ' | 'NEXT_CHUNK' | 'INIT_WRITE' | 'WRITE_CHUNK';
  payload?: any;
}