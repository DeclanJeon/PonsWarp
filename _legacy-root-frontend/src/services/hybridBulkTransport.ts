/**
 * Hybrid bulk transport helpers.
 * Design: docs/design/hybrid-bulk-transport.md
 *
 * WebRTC remains the control + baseline bulk path.
 * Encrypted HTTP assist uploads the same ciphertext packet stream to Cloud Drop
 * so the receiver can fetch in parallel when P2P/TURN is slow.
 */

import {
  HYBRID_HTTP_ASSIST,
  HYBRID_MIN_BYTES,
  HYBRID_UPLOAD_CONCURRENCY,
} from '../utils/constants';
import { logInfo, logWarn, logError } from '../utils/logger';
import {
  completeCloudShare,
  createCloudShare,
  getCloudDownloadUrl,
  uploadCloudFile,
  type CloudUploadTarget,
} from './cloudShareService';
import type { ScannedFile } from '../utils/fileScanner';

export interface HybridPeerCaps {
  hybridHttp: boolean;
  version: 1;
}

export interface HybridManifestMsg {
  type: 'HYBRID_MANIFEST';
  runId: number;
  shareId: string;
  fileId: string;
  objectBytes: number;
  packetCount: number;
  totalPayloadBytes: number;
  downloadSessionToken?: string;
}

export interface HybridReadyMsg {
  type: 'HYBRID_READY';
  runId: number;
  shareId: string;
  fileId: string;
}

export interface HybridArmDecision {
  armed: boolean;
  reason: string;
}

export function isHybridCompileEnabled(): boolean {
  return HYBRID_HTTP_ASSIST === true;
}

export function shouldArmHybrid(params: {
  compileEnabled?: boolean;
  remoteCaps?: HybridPeerCaps | null;
  totalBytes: number;
  cloudApiConfigured: boolean;
  minBytes?: number;
}): HybridArmDecision {
  const compileEnabled = params.compileEnabled ?? isHybridCompileEnabled();
  if (!compileEnabled) {
    return { armed: false, reason: 'compile-flag-off' };
  }
  if (!params.cloudApiConfigured) {
    return { armed: false, reason: 'cloud-api-unconfigured' };
  }
  if (!params.remoteCaps?.hybridHttp) {
    return { armed: false, reason: 'remote-caps-missing' };
  }
  const minBytes = params.minBytes ?? HYBRID_MIN_BYTES;
  if (params.totalBytes < minBytes) {
    return { armed: false, reason: `below-min-bytes:${minBytes}` };
  }
  return { armed: true, reason: 'ok' };
}

/** Length-delimited packet framing for the hybrid HTTP object. */
export function frameHybridPackets(packets: ArrayBuffer[]): Uint8Array {
  let total = 0;
  for (const p of packets) total += 4 + p.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of packets) {
    const view = new DataView(out.buffer, out.byteOffset + o, 4);
    view.setUint32(0, p.byteLength, false);
    o += 4;
    out.set(new Uint8Array(p), o);
    o += p.byteLength;
  }
  return out;
}

export function parseHybridFramedObject(buf: ArrayBuffer): ArrayBuffer[] {
  const packets: ArrayBuffer[] = [];
  const u8 = new Uint8Array(buf);
  let o = 0;
  while (o + 4 <= u8.byteLength) {
    const len = new DataView(u8.buffer, u8.byteOffset + o, 4).getUint32(0, false);
    o += 4;
    if (len <= 0 || o + len > u8.byteLength) {
      throw new Error(
        `Invalid hybrid frame at ${o - 4}: len=${len} remaining=${u8.byteLength - o}`
      );
    }
    packets.push(u8.buffer.slice(u8.byteOffset + o, u8.byteOffset + o + len));
    o += len;
  }
  if (o !== u8.byteLength) {
    throw new Error(`Trailing hybrid bytes: ${u8.byteLength - o}`);
  }
  return packets;
}

export interface HybridUploadResult {
  manifest: HybridManifestMsg;
  ready: HybridReadyMsg;
}

/**
 * Build framed ciphertext object and upload via free Cloud Drop APIs.
 * `buildPackets` must return the same encrypted packets WebRTC uses.
 */
export async function uploadHybridAssistObject(params: {
  runId: number;
  totalPayloadBytes: number;
  buildPackets: () => Promise<ArrayBuffer[]>;
  onProgress?: (loaded: number, total: number) => void;
}): Promise<HybridUploadResult> {
  const packets = await params.buildPackets();
  const framed = frameHybridPackets(packets);
  const blob = new Blob([framed.slice()], { type: 'application/octet-stream' });
  const file = new File([blob], `hybrid-run-${params.runId}.bin`, {
    type: 'application/octet-stream',
  });

  const filesForApi: ScannedFile[] = [
    {
      file,
      path: file.name,
    },
  ];

  logInfo(
    '[Hybrid]',
    `Creating cloud share for hybrid object (${file.size} bytes, ${packets.length} packets)`
  );

  const created = await createCloudShare(`hybrid-${params.runId}`, filesForApi, {
    retentionSeconds: 24 * 60 * 60,
    downloadLimit: 32,
  });
  const target: CloudUploadTarget | undefined = created.files[0];
  if (!target) {
    throw new Error('Hybrid cloud share returned no upload target');
  }

  void HYBRID_UPLOAD_CONCURRENCY; // reserved for future multi-blob fanout

  const multipart = await uploadCloudFile(target, file, progress => {
    params.onProgress?.(progress.loaded, progress.total || file.size);
  });

  const completed = await completeCloudShare(
    created.shareId,
    [target.id],
    multipart ? [multipart] : []
  );

  const manifest: HybridManifestMsg = {
    type: 'HYBRID_MANIFEST',
    runId: params.runId,
    shareId: created.shareId,
    fileId: target.id,
    objectBytes: file.size,
    packetCount: packets.length,
    totalPayloadBytes: params.totalPayloadBytes,
    downloadSessionToken: completed.downloadSessionToken,
  };
  const ready: HybridReadyMsg = {
    type: 'HYBRID_READY',
    runId: params.runId,
    shareId: created.shareId,
    fileId: target.id,
  };

  logInfo(
    '[Hybrid]',
    `Hybrid object ready share=${created.shareId} file=${target.id}`
  );
  return { manifest, ready };
}

export async function downloadHybridAssistPackets(
  manifest: HybridManifestMsg,
  onPacket: (packet: ArrayBuffer) => Promise<void> | void,
  options?: { signal?: AbortSignal }
): Promise<{ packetCount: number; bytes: number }> {
  const url = getCloudDownloadUrl(
    manifest.shareId,
    manifest.fileId,
    manifest.downloadSessionToken
  );
  logInfo('[Hybrid]', `Downloading hybrid object ${url}`);
  const response = await fetch(url, { signal: options?.signal });
  if (!response.ok) {
    throw new Error(`Hybrid download failed: HTTP ${response.status}`);
  }
  const buf = await response.arrayBuffer();
  if (manifest.objectBytes > 0 && buf.byteLength !== manifest.objectBytes) {
    logWarn(
      '[Hybrid]',
      `Object size mismatch: got ${buf.byteLength} expected ${manifest.objectBytes}`
    );
  }
  const packets = parseHybridFramedObject(buf);
  let bytes = 0;
  for (const packet of packets) {
    bytes += packet.byteLength;
    await onPacket(packet);
  }
  return { packetCount: packets.length, bytes };
}

export function cloudApiConfigured(): boolean {
  const base = (import.meta.env.VITE_CLOUD_API_BASE_URL || '').trim();
  return base.length > 0;
}

export function localHybridCaps(): HybridPeerCaps {
  return {
    hybridHttp: isHybridCompileEnabled() && cloudApiConfigured(),
    version: 1,
  };
}

export function safeParseHybridCaps(msg: unknown): HybridPeerCaps | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'PEER_CAPS') return null;
  return {
    hybridHttp: m.hybridHttp === true,
    version: 1,
  };
}
