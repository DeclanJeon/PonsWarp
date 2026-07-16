/// <reference lib="webworker" />

self.onmessage = async (
  ev: MessageEvent<{ id: string; file: File; offset: number; size: number }>,
) => {
  const { id, file, offset, size } = ev.data;
  try {
    const slice = file.slice(offset, offset + size);
    const buffer = await slice.arrayBuffer();
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, buffer, offset }, [buffer]);
  } catch (error) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "read failed",
    });
  }
};

export {};
