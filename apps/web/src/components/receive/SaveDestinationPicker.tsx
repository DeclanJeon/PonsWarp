"use client";

export async function pickSaveDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (!w.showDirectoryPicker) return null;
  try {
    return await w.showDirectoryPicker();
  } catch {
    return null;
  }
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}
