/**
 * Transfer State Management using idb-keyval
 * 전송 중단 시 재개를 위한 상태 저장
 */
import { get, set, del, entries } from 'idb-keyval';

export interface TransferState {
  transferId: string;
  fileName: string;
  fileSize: number;
  completedChunks: number[];
  timestamp: number;
  checksum?: string;
}

export const saveTransferState = async (state: TransferState): Promise<void> => {
  await set(`transfer-${state.transferId}`, state);
};

export const loadTransferState = async (transferId: string): Promise<TransferState | undefined> => {
  return await get<TransferState>(`transfer-${transferId}`);
};

export const clearTransferState = async (transferId: string): Promise<void> => {
  await del(`transfer-${transferId}`);
};

export const getAllTransferStates = async (): Promise<TransferState[]> => {
  const allEntries = await entries();
  return allEntries
    .filter(([key]) => (key as string).startsWith('transfer-'))
    .map(([, value]) => value as TransferState);
};

export const clearOldTransferStates = async (maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<void> => {
  const allStates = await getAllTransferStates();
  const now = Date.now();
  
  for (const state of allStates) {
    if (now - state.timestamp > maxAge) {
      await clearTransferState(state.transferId);
    }
  }
};