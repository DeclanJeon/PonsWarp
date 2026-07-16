"use client";

import { create } from "zustand";
import type {
  MotionIntensity,
  PeerConnectionMode,
  Role,
  TransferFileItem,
  TransferProgress,
  TransferViewState,
} from "@/lib/types";
import { EMPTY_PROGRESS } from "@/lib/types";

type TransferStore = {
  role: Role | null;
  viewState: TransferViewState;
  files: TransferFileItem[];
  progress: TransferProgress;
  sessionId: string | null;
  code: string | null;
  expiresAt: number | null;
  shareUrl: string | null;
  connectionMode: PeerConnectionMode;
  errorMessage: string | null;
  errorCode: string | null;
  bufferedAmount: number;
  motionIntensity: MotionIntensity;
  receivedBlobs: { id: string; name: string; url: string }[];
  setRole: (role: Role | null) => void;
  setViewState: (state: TransferViewState) => void;
  setFiles: (files: TransferFileItem[]) => void;
  setProgress: (progress: TransferProgress) => void;
  setSession: (info: { sessionId: string; code: string; expiresAt: number; shareUrl: string }) => void;
  setConnectionMode: (mode: PeerConnectionMode) => void;
  setError: (message: string | null, code?: string | null) => void;
  setBufferedAmount: (n: number) => void;
  setMotionIntensity: (m: MotionIntensity) => void;
  addReceivedBlob: (item: { id: string; name: string; url: string }) => void;
  reset: () => void;
};

const initial = {
  role: null as Role | null,
  viewState: "idle" as TransferViewState,
  files: [] as TransferFileItem[],
  progress: EMPTY_PROGRESS,
  sessionId: null as string | null,
  code: null as string | null,
  expiresAt: null as number | null,
  shareUrl: null as string | null,
  connectionMode: "unknown" as PeerConnectionMode,
  errorMessage: null as string | null,
  errorCode: null as string | null,
  bufferedAmount: 0,
  motionIntensity: "full" as MotionIntensity,
  receivedBlobs: [] as { id: string; name: string; url: string }[],
};

export const useTransferStore = create<TransferStore>((set) => ({
  ...initial,
  setRole: (role) => set({ role }),
  setViewState: (viewState) => set({ viewState }),
  setFiles: (files) => set({ files }),
  setProgress: (progress) => set({ progress }),
  setSession: ({ sessionId, code, expiresAt, shareUrl }) => set({ sessionId, code, expiresAt, shareUrl }),
  setConnectionMode: (connectionMode) => set({ connectionMode }),
  setError: (errorMessage, errorCode = null) => set({ errorMessage, errorCode }),
  setBufferedAmount: (bufferedAmount) => set({ bufferedAmount }),
  setMotionIntensity: (motionIntensity) => set({ motionIntensity }),
  addReceivedBlob: (item) => set((s) => ({ receivedBlobs: [...s.receivedBlobs.filter((x) => x.id !== item.id), item] })),
  reset: () => set({ ...initial, motionIntensity: useTransferStore.getState().motionIntensity }),
}));
