export type WriterBackend = "fs-access" | "opfs" | "streamsaver" | "memory";

export type StreamingWriter = {
  backend: WriterBackend;
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<{ downloadUrl?: string; fileName: string }>;
  abort: () => Promise<void>;
};

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024; // 64MB hard cap for in-memory fallback

function asBufferSource(chunk: Uint8Array): BufferSource {
  return chunk as BufferSource;
}

function supportsOpfs(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

async function openFsAccessWriter(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<StreamingWriter | null> {
  try {
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    return {
      backend: "fs-access",
      write: async (chunk) => {
        await writable.write(asBufferSource(chunk));
      },
      close: async () => {
        await writable.close();
        return { fileName };
      },
      abort: async () => {
        try {
          await writable.abort?.();
        } catch {
          try {
            await writable.close();
          } catch {
            /* ignore */
          }
        }
      },
    };
  } catch {
    return null;
  }
}

async function openOpfsWriter(fileName: string): Promise<StreamingWriter | null> {
  if (!supportsOpfs()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const safeName = fileName.replace(/[\\/]/g, "_");
    const handle = await root.getFileHandle(safeName, { create: true });
    const writable = await handle.createWritable();
    return {
      backend: "opfs",
      write: async (chunk) => {
        await writable.write(asBufferSource(chunk));
      },
      close: async () => {
        await writable.close();
        const file = await handle.getFile();
        const downloadUrl = URL.createObjectURL(file);
        return { downloadUrl, fileName: safeName };
      },
      abort: async () => {
        try {
          await writable.abort?.();
        } catch {
          try {
            await writable.close();
          } catch {
            /* ignore */
          }
        }
        try {
          await root.removeEntry(safeName);
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return null;
  }
}

async function openStreamSaverWriter(fileName: string, size: number): Promise<StreamingWriter | null> {
  // Dynamic import: streamsaver touches `document` at module load and must stay client-only.
  try {
    const mod = await import("streamsaver");
    const streamSaver = mod.default;
    if (typeof window !== "undefined") {
      (streamSaver as { mitm?: string }).mitm = `${window.location.origin}/streamsaver/mitm.html`;
    }
    const fileStream = streamSaver.createWriteStream(fileName, size > 0 ? { size } : undefined);
    const writer = fileStream.getWriter();
    return {
      backend: "streamsaver",
      write: async (chunk) => {
        await writer.write(chunk);
      },
      close: async () => {
        await writer.close();
        return { fileName };
      },
      abort: async () => {
        try {
          await writer.abort();
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return null;
  }
}

function openMemoryWriter(fileName: string, expectedSize: number): StreamingWriter {
  if (expectedSize > MEMORY_LIMIT_BYTES) {
    throw new Error(
      `File is too large for memory download (${Math.ceil(expectedSize / (1024 * 1024))}MB). Use Chrome/Edge for streaming save.`,
    );
  }
  const parts: BlobPart[] = [];
  return {
    backend: "memory",
    write: async (chunk) => {
      parts.push(chunk.slice());
    },
    close: async () => {
      const blob = new Blob(parts);
      const downloadUrl = URL.createObjectURL(blob);
      return { downloadUrl, fileName };
    },
    abort: async () => {
      parts.length = 0;
    },
  };
}

export async function openStreamingWriter(opts: {
  fileName: string;
  size: number;
  directoryHandle?: FileSystemDirectoryHandle | null;
  preferStreamSaver?: boolean;
}): Promise<StreamingWriter> {
  const { fileName, size, directoryHandle, preferStreamSaver } = opts;

  if (directoryHandle) {
    const fs = await openFsAccessWriter(directoryHandle, fileName);
    if (fs) return fs;
  }

  // Large files: prefer OPFS then StreamSaver. Never fall back to unbounded memory.
  if (size > MEMORY_LIMIT_BYTES || preferStreamSaver) {
    const opfs = await openOpfsWriter(fileName);
    if (opfs) return opfs;
    const ss = await openStreamSaverWriter(fileName, size);
    if (ss) return ss;
    throw new Error(
      "Large file streaming is unavailable in this browser. Use Chrome/Edge, or choose a save folder.",
    );
  }

  const opfsSmall = await openOpfsWriter(fileName);
  if (opfsSmall) return opfsSmall;
  return openMemoryWriter(fileName, size);
}

export function triggerDownload(url: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
