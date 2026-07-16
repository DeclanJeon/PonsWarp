"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  clearPersistedSendSession,
  destroyTransferEngine,
  getTransferEngine,
  persistSendSession,
  readPersistedSendSession,
  type SaveMode,
} from "@/lib/webrtc/session-runtime";
import { updateMotionFromTransfer } from "@/stores/motion-store";
import { useTransferStore } from "@/stores/transfer-store";
import type { Role } from "@/lib/types";

export function useTransferSession(role: Role) {
  const engineRef = useRef(getTransferEngine(role));
  const store = useTransferStore();

  useEffect(() => {
    const engine = getTransferEngine(role);
    engineRef.current = engine;
    store.setRole(role);

    engine.setEvents({
      onViewState: (viewState) => {
        store.setViewState(viewState);
        const s = useTransferStore.getState();
        updateMotionFromTransfer({
          viewState,
          role,
          progress: s.progress.progress,
          speedBps: s.progress.currentSpeedBps,
          bufferedAmount: s.bufferedAmount,
          intensity: s.motionIntensity,
        });
      },
      onProgress: (progress) => {
        store.setProgress(progress);
        const s = useTransferStore.getState();
        updateMotionFromTransfer({
          viewState: s.viewState,
          role,
          progress: progress.progress,
          speedBps: progress.currentSpeedBps,
          bufferedAmount: s.bufferedAmount,
          intensity: s.motionIntensity,
        });
      },
      onFiles: (files) => {
        store.setFiles(files);
        if (role === "sender") {
          const roomId = engine.getRoomId();
          if (roomId && files.length) {
            persistSendSession({
              code: roomId,
              fileNames: files.map((f) => f.name),
              totalBytes: files.reduce((sum, f) => sum + f.size, 0),
              createdAt: Date.now(),
            });
          }
        }
      },
      onConnectionMode: (mode) => store.setConnectionMode(mode),
      onSession: ({ sessionId, code, expiresAt }) => {
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        store.setSession({
          sessionId,
          code,
          expiresAt,
          shareUrl: `${origin}/receive/${code}`,
        });
        if (role === "sender") {
          const files = engine.getFiles();
          persistSendSession({
            code,
            fileNames: files.map((f) => f.name),
            totalBytes: files.reduce((sum, f) => sum + f.size, 0),
            createdAt: Date.now(),
          });
        }
      },
      onError: (message, code) => store.setError(message, code ?? null),
      onBufferedAmount: (n) => {
        store.setBufferedAmount(n);
        const s = useTransferStore.getState();
        updateMotionFromTransfer({
          viewState: s.viewState,
          role,
          progress: s.progress.progress,
          speedBps: s.progress.currentSpeedBps,
          bufferedAmount: n,
          intensity: s.motionIntensity,
        });
      },
      onReceivedFile: ({ id, name, downloadUrl }) => {
        if (!downloadUrl) return;
        store.addReceivedBlob({ id, name, url: downloadUrl });
      },
    });

    // Rehydrate from live engine first.
    store.setViewState(engine.getViewState());
    store.setFiles(engine.getFiles());
    store.setProgress(engine.getProgress());
    const roomId = engine.getRoomId();
    if (roomId) {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      store.setSession({
        sessionId: roomId,
        code: roomId,
        expiresAt: Date.now() + 30 * 60 * 1000,
        shareUrl: `${origin}/receive/${roomId}`,
      });
      if (engine.getViewState() === "idle" || engine.getViewState() === "files-selected") {
        store.setViewState("waiting-receiver");
      }
      // Ensure signaling handlers remain attached after remount.
      void engine.createSession(roomId).catch(() => undefined);
    } else if (role === "sender") {
      // Full reload: restore code UI and re-join the same room so receivers can still connect.
      const persisted = readPersistedSendSession();
      if (persisted?.code) {
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        store.setSession({
          sessionId: persisted.code,
          code: persisted.code,
          expiresAt: Date.now() + 30 * 60 * 1000,
          shareUrl: `${origin}/receive/${persisted.code}`,
        });
        store.setViewState("waiting-receiver");
        if (!engine.getFiles().length && persisted.fileNames.length) {
          store.setFiles(
            persisted.fileNames.map((name, i) => ({
              id: `persisted-${i}-${name}`,
              name,
              size: Math.floor(persisted.totalBytes / Math.max(1, persisted.fileNames.length)) || 0,
              type: "application/octet-stream",
              state: "queued",
              transferredBytes: 0,
              progress: 0,
            })),
          );
        }

        // Re-open the same room id on signaling.
        void engine.createSession(persisted.code).catch(() => {
          store.setError("Sender session was reloaded. Re-select files to open a new room.", "session-reloaded");
        });
      }
    }
    return () => {
      // Keep sender/receiver engines alive across route changes.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  const setFiles = useCallback(async (files: File[]) => {
    await engineRef.current?.setLocalFiles(files);
  }, []);

  const createSession = useCallback(async () => {
    await engineRef.current?.createSession();
  }, []);

  const joinSession = useCallback(async (code: string) => {
    await engineRef.current?.joinSession(code);
  }, []);

  const accept = useCallback(async (saveMode: SaveMode = "blob", directoryHandle?: FileSystemDirectoryHandle | null) => {
    if (directoryHandle) engineRef.current?.setDirectoryHandle(directoryHandle);
    await engineRef.current?.acceptIncoming(saveMode);
  }, []);

  const reject = useCallback(() => {
    engineRef.current?.rejectIncoming();
    destroyTransferEngine(role);
  }, [role]);

  const startTransfer = useCallback(async () => {
    await engineRef.current?.startTransfer();
  }, []);

  const pause = useCallback(() => engineRef.current?.pause(), []);
  const resume = useCallback(() => engineRef.current?.resume(), []);

  const endSession = useCallback(() => {
    destroyTransferEngine(role);
    clearPersistedSendSession();
    store.reset();
  }, [role, store]);

  return {
    setFiles,
    createSession,
    joinSession,
    accept,
    reject,
    startTransfer,
    pause,
    resume,
    endSession,
    engine: engineRef,
  };
}
