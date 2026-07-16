export type WriterBackend = "fs-access" | "opfs" | "streamsaver" | "memory";

export type StreamingWriter = {
  backend: WriterBackend;
  write: (chunk: Uint8Array) => Promise<void>;
  /** Optional batch write path used by the transfer engine reassembly loop. */
  writeMany?: (chunks: Uint8Array[]) => Promise<void>;
  close: () => Promise<{ downloadUrl?: string; fileName: string }>;
  abort: () => Promise<void>;
};

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024; // 64MB hard cap for in-memory fallback
const BATCH_FLUSH_BYTES = 1024 * 1024; // 1 MiB coalesced flush for disk writers

function asBufferSource(chunk: Uint8Array): BufferSource {
  return chunk as BufferSource;
}

function supportsOpfs(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

function withBatching(
  backend: WriterBackend,
  writeOne: (chunk: Uint8Array) => Promise<void>,
  closeInner: () => Promise<{ downloadUrl?: string; fileName: string }>,
  abortInner: () => Promise<void>,
): StreamingWriter {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let chain: Promise<void> = Promise.resolve();

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    // Prefer one large write when possible.
    if (batch.length === 1) {
      await writeOne(batch[0]!);
      return;
    }
    const total = batch.reduce((s, c) => s + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of batch) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    await writeOne(merged);
  };

  const enqueue = (chunk: Uint8Array) => {
    chain = chain.then(async () => {
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      if (pendingBytes >= BATCH_FLUSH_BYTES) await flush();
    });
    return chain;
  };

  return {
    backend,
    write: (chunk) => enqueue(chunk),
    writeMany: async (chunks) => {
      for (const chunk of chunks) await enqueue(chunk);
    },
    close: async () => {
      await chain;
      await flush();
      return closeInner();
    },
    abort: async () => {
      pending = [];
      pendingBytes = 0;
      try {
        await chain;
      } catch {
        /* ignore */
      }
      await abortInner();
    },
  };
}

async function openFsAccessWriter(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<StreamingWriter | null> {
  try {
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    return withBatching(
      "fs-access",
      async (chunk) => {
        await writable.write(asBufferSource(chunk));
      },
      async () => {
        await writable.close();
        return { fileName };
      },
      async () => {
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
    );
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
    return withBatching(
      "opfs",
      async (chunk) => {
        await writable.write(asBufferSource(chunk));
      },
      async () => {
        await writable.close();
        const file = await handle.getFile();
        const downloadUrl = URL.createObjectURL(file);
        return { downloadUrl, fileName: safeName };
      },
      async () => {
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
    );
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
    return withBatching(
      "streamsaver",
      async (chunk) => {
        await writer.write(chunk);
      },
      async () => {
        await writer.close();
        return { fileName };
      },
      async () => {
        try {
          await writer.abort();
        } catch {
          /* ignore */
        }
      },
    );
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
    writeMany: async (chunks) => {
      for (const chunk of chunks) parts.push(chunk.slice());
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
  // OPFS first is much faster than StreamSaver mitm for headless/automated runs.
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
