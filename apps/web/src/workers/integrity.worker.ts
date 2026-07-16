/// <reference lib="webworker" />

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

self.onmessage = async (ev: MessageEvent<{ id: string; buffer: ArrayBuffer }>) => {
  const { id, buffer } = ev.data;
  try {
    const checksum = await sha256Hex(buffer);
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, checksum });
  } catch (error) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "hash failed",
    });
  }
};

export {};
