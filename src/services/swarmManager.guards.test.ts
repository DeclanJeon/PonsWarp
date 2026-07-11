import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransferManifest } from '../types/types';

const signalingService = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  connect: vi.fn(async () => undefined),
  joinRoom: vi.fn(async () => undefined),
  requestTurnConfig: vi.fn(async () => ({ success: true, data: { iceServers: [] } })),
  getSocketId: vi.fn(() => 'sender-socket'),
  reconnect: vi.fn(async () => undefined),
}));

vi.mock('./signaling-factory', () => ({
  getSignalingService: () => signalingService,
}));


afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  signalingService.requestTurnConfig.mockReset();
  signalingService.connect.mockReset();
  signalingService.connect.mockResolvedValue(undefined);
  signalingService.joinRoom.mockReset();
  signalingService.joinRoom.mockResolvedValue(undefined);
  signalingService.getSocketId.mockReset();
  signalingService.getSocketId.mockReturnValue('sender-socket');
  signalingService.reconnect.mockReset();
  signalingService.reconnect.mockResolvedValue(undefined);
  signalingService.requestTurnConfig.mockResolvedValue({
    success: true,
    data: { iceServers: [] },
  });
});

function createManifest(totalSize: number): TransferManifest {
  return {
    transferId: 'test-transfer',
    totalSize,
    totalFiles: 1,
    rootName: 'test.bin',
    files: [
      {
        id: 0,
        name: 'test.bin',
        path: 'test.bin',
        size: totalSize,
        type: 'application/octet-stream',
        lastModified: 1,
      },
    ],
    isFolder: false,
  };
}

describe('SwarmManager guard paths', () => {
  it('rejoins the active room after signaling reconnects', async () => {
    const { SwarmManager } = await import('./swarmManager');
    const manager = new SwarmManager({ signaling: signalingService as never });
    const managerInternals = manager as unknown as {
      roomId: string;
      signalingRecoveryPromise: Promise<void> | null;
      handleSignalingConnected(): void;
    };
    managerInternals.roomId = 'ABC123';

    managerInternals.handleSignalingConnected();
    await managerInternals.signalingRecoveryPromise;

    expect(signalingService.requestTurnConfig).toHaveBeenCalledWith('ABC123');
    expect(signalingService.joinRoom).toHaveBeenCalledWith('ABC123');
    manager.cleanup();
  });

  it('initiates peers already present when the sender rejoins a room', async () => {
    const { SwarmManager } = await import('./swarmManager');
    const manager = new SwarmManager({ signaling: signalingService as never });
    const addPeer = vi.fn();
    const managerInternals = manager as unknown as {
      roomId: string;
      addPeer: typeof addPeer;
      handleRoomUsers(data: { users: string[] }): void;
    };
    managerInternals.roomId = 'ABC123';
    managerInternals.addPeer = addPeer;

    managerInternals.handleRoomUsers({
      users: ['sender-socket', 'receiver-socket'],
    });

    expect(addPeer).toHaveBeenCalledOnce();
    expect(addPeer).toHaveBeenCalledWith('receiver-socket', true);
    manager.cleanup();
  });
  it('rejects resume requests beyond the manifest size instead of restarting from an unsafe offset', async () => {
    const { SwarmManager } = await import('./swarmManager');
    const manager = new SwarmManager();
    const failures: unknown[] = [];
    manager.on('transfer-failed', message => failures.push(message));

    const managerInternals = manager as unknown as {
      pendingManifest: TransferManifest;
      handleResumeRequest(peerId: string, msg: { offset: number }): void;
    };
    managerInternals.pendingManifest = createManifest(1024);

    managerInternals.handleResumeRequest('peer-1', { offset: 1025 });

    expect(failures).toEqual([
      'Receiver requested an invalid resume offset (1025)',
    ]);
  });

  it('rejects fractional resume offsets instead of flooring them', async () => {
    const { SwarmManager } = await import('./swarmManager');
    const manager = new SwarmManager();
    const failures: unknown[] = [];
    manager.on('transfer-failed', message => failures.push(message));

    const managerInternals = manager as unknown as {
      pendingManifest: TransferManifest;
      handleResumeRequest(peerId: string, msg: { offset: number }): void;
    };
    managerInternals.pendingManifest = createManifest(1024);

    managerInternals.handleResumeRequest('peer-1', { offset: 1.5 });

    expect(failures).toEqual([
      'Receiver requested an invalid resume offset (1.5)',
    ]);
  });
  it('rejects string resume offsets instead of coercing them', async () => {
    const { SwarmManager } = await import('./swarmManager');
    const manager = new SwarmManager();
    const failures: unknown[] = [];
    manager.on('transfer-failed', message => failures.push(message));

    const managerInternals = manager as unknown as {
      pendingManifest: TransferManifest;
      handleResumeRequest(peerId: string, msg: { offset: unknown }): void;
    };
    managerInternals.pendingManifest = createManifest(1024);

    managerInternals.handleResumeRequest('peer-1', { offset: '512' });

    expect(failures).toEqual([
      'Receiver requested an invalid resume offset (512)',
    ]);
  });


  it('rejects non-finite receiver download sizes', async () => {
    const { SwarmManager } = await import('./swarmManager');
    const manager = new SwarmManager();
    const failures: unknown[] = [];
    manager.on('transfer-failed', message => failures.push(message));

    const managerInternals = manager as unknown as {
      handleControlMessage(
        peerId: string,
        msg: { type: 'DOWNLOAD_COMPLETE'; actualSize: unknown }
      ): void;
    };

    managerInternals.handleControlMessage('peer-1', {
      type: 'DOWNLOAD_COMPLETE',
      actualSize: Number.NaN,
    });

    expect(failures).toEqual([
      'Receiver did not report a valid saved file size',
    ]);
  });
  it('rejects string receiver download sizes instead of coercing them', async () => {
    const { SwarmManager } = await import('./swarmManager');
    const manager = new SwarmManager();
    const failures: unknown[] = [];
    manager.on('transfer-failed', message => failures.push(message));

    const managerInternals = manager as unknown as {
      handleControlMessage(
        peerId: string,
        msg: { type: 'DOWNLOAD_COMPLETE'; actualSize: unknown }
      ): void;
    };

    managerInternals.handleControlMessage('peer-1', {
      type: 'DOWNLOAD_COMPLETE',
      actualSize: '2048',
    });

    expect(failures).toEqual([
      'Receiver did not report a valid saved file size',
    ]);
  });


  it('rejects incomplete receiver download sizes for exact-size manifests', async () => {
    const { SwarmManager } = await import('./swarmManager');
    const manager = new SwarmManager();
    const failures: unknown[] = [];
    manager.on('transfer-failed', message => failures.push(message));

    const managerInternals = manager as unknown as {
      pendingManifest: TransferManifest;
      handleControlMessage(
        peerId: string,
        msg: { type: 'DOWNLOAD_COMPLETE'; actualSize: number }
      ): void;
    };
    managerInternals.pendingManifest = createManifest(2048);

    managerInternals.handleControlMessage('peer-1', {
      type: 'DOWNLOAD_COMPLETE',
      actualSize: 1024,
    });

    expect(failures).toEqual(['Receiver saved only 1024 of 2048 bytes']);
  });
  it('ignores stale or coercible partition ACKs instead of mutating the active run', async () => {
    const { SwarmManager } = await import('./swarmManager');
    const manager = new SwarmManager();

    const waiter = { runId: 1, peers: new Set(['peer-1']) };
    const managerInternals = manager as unknown as {
      transferRunId: number;
      partitionAckWaiters: Map<
        number,
        { runId: number; peers: Set<string> }
      >;
      partitionAckCount: number;
      handleControlMessage(
        peerId: string,
        msg: { type: 'PARTITION_ACK'; offset: unknown; runId: unknown }
      ): void;
    };
    managerInternals.transferRunId = 2;
    managerInternals.partitionAckWaiters.set(4096, waiter);

    managerInternals.handleControlMessage('peer-1', {
      type: 'PARTITION_ACK',
      offset: 4096,
      runId: 1,
    });
    managerInternals.handleControlMessage('peer-1', {
      type: 'PARTITION_ACK',
      offset: '4096',
      runId: 2,
    });

    expect(waiter.peers.has('peer-1')).toBe(true);
    expect(managerInternals.partitionAckCount).toBe(0);

    managerInternals.transferRunId = 1;
    managerInternals.handleControlMessage('peer-1', {
      type: 'PARTITION_ACK',
      offset: 4096,
      runId: 1,
    });

    expect(waiter.peers.has('peer-1')).toBe(false);
    expect(managerInternals.partitionAckWaiters.has(4096)).toBe(false);
    expect(managerInternals.partitionAckCount).toBe(1);
  });


  it('encrypts partitioned data packets when sender encryption is enabled', async () => {
    const { SwarmManager } = await import('./swarmManager');
    const manager = new SwarmManager();
    manager.enableEncryption();
    manager.setSessionKey(
      new Uint8Array(32).fill(7),
      new Uint8Array(8).fill(9)
    );

    const managerInternals = manager as unknown as {
      createPartitionDataPacket(params: {
        payload: ArrayBuffer;
        sequence: number;
        offset: number;
      }): Promise<ArrayBuffer>;
    };
    const payload = new TextEncoder().encode('encrypted-payload-check');
    const packet = await managerInternals.createPartitionDataPacket({
      payload: payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength
      ),
      sequence: 42,
      offset: 123456,
    });

    const packetBytes = new Uint8Array(packet);
    const packetView = new DataView(packet);
    expect(packetBytes[0]).toBe(0x02);
    expect(packetView.getUint32(4, true)).toBe(42);
    expect(Number(packetView.getBigUint64(8, true))).toBe(123456);
    expect(packetView.getUint32(16, true)).toBe(payload.byteLength);
    expect(new TextDecoder().decode(packetBytes)).not.toContain(
      'encrypted-payload-check'
    );
  });
  it('decrypts encrypted partition packets through the direct writer WebCrypto path', async () => {
    const [{ SwarmManager }, { DirectFileWriter }] = await Promise.all([
      import('./swarmManager'),
      import('./directFileWriter'),
    ]);
    const sessionKey = new Uint8Array(32).fill(11);
    const randomPrefix = new Uint8Array(8).fill(13);
    const manager = new SwarmManager();
    manager.enableEncryption();
    manager.setSessionKey(sessionKey, randomPrefix);

    const payload = new TextEncoder().encode('receiver-webcrypto-check');
    const packet = await (manager as unknown as {
      createPartitionDataPacket(params: {
        payload: ArrayBuffer;
        sequence: number;
        offset: number;
      }): Promise<ArrayBuffer>;
    }).createPartitionDataPacket({
      payload: payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength
      ),
      sequence: 7,
      offset: 4096,
    });

    const writer = new DirectFileWriter();
    writer.setEncryptionKey(sessionKey, randomPrefix);
    const normalized = await (writer as unknown as {
      normalizePacket(packet: ArrayBuffer): Promise<ArrayBuffer>;
    }).normalizePacket(packet);

    const view = new DataView(normalized);
    const normalizedPayload = new Uint8Array(normalized, 22);
    expect(view.getUint16(0, true)).toBe(0);
    expect(view.getBigUint64(6, true)).toBe(4096n);
    expect(view.getUint32(14, true)).toBe(payload.byteLength);
    expect(new TextDecoder().decode(normalizedPayload)).toBe(
      'receiver-webcrypto-check'
    );
  });
  it('leaves plain packets with file id 2 on the plain normalization path', async () => {
    const { DirectFileWriter } = await import('./directFileWriter');
    const writer = new DirectFileWriter();
    const packet = new ArrayBuffer(22 + 3);
    const view = new DataView(packet);
    const bytes = new Uint8Array(packet);
    view.setUint16(0, 2, true);
    view.setUint32(14, 3, true);
    bytes.set([1, 2, 3], 22);

    const normalized = await (writer as unknown as {
      normalizePacket(packet: ArrayBuffer): Promise<ArrayBuffer>;
    }).normalizePacket(packet);

    expect(normalized).toBe(packet);
  });
  it('parses receiver string control frames instead of passing them to the writer', async () => {
    const { transferService } = await import('./webRTCService');
    const writer = { writeChunk: vi.fn(async () => undefined) };
    const metadata: TransferManifest[] = [];

    const receiverInternals = transferService as unknown as {
      eventListeners: Record<string, Array<(data: unknown) => void>>;
      writer: { writeChunk: (packet: ArrayBuffer) => Promise<void> };
      handleData(data: string | ArrayBuffer): void;
    };
    receiverInternals.eventListeners = {};
    receiverInternals.writer = writer;
    transferService.on('metadata', data =>
      metadata.push(data as TransferManifest)
    );

    receiverInternals.handleData(
      JSON.stringify({ type: 'MANIFEST', manifest: createManifest(1234) })
    );
    await Promise.resolve();

    expect(metadata[0]?.totalSize).toBe(1234);
    expect(writer.writeChunk).not.toHaveBeenCalled();
  });

  it('rejects receiver write failures instead of ACK-masking them through the queue', async () => {
    const { DirectFileWriter } = await import('./directFileWriter');
    const writer = new DirectFileWriter();

    await expect(writer.writeChunk(new ArrayBuffer(4))).rejects.toThrow(
      'Packet too short'
    );
    await expect(writer.waitForIdle()).rejects.toThrow('Packet too short');
    await expect(writer.writeChunk(new ArrayBuffer(22))).rejects.toThrow(
      'Packet too short'
    );
  });
  it('rejects final writer close failures instead of reporting completion', async () => {
    const { DirectFileWriter } = await import('./directFileWriter');
    const writer = new DirectFileWriter();
    const completed: number[] = [];
    const failures: string[] = [];

    const writerInternals = writer as unknown as {
      writer: { close: () => Promise<void> };
      writerMode: 'streamsaver';
      onCompleteCallback: (actualSize: number) => void;
      onErrorCallback: (error: string) => void;
      finalize(): Promise<void>;
    };
    writerInternals.writer = {
      close: vi.fn(async () => {
        throw new Error('disk commit failed');
      }),
    };
    writerInternals.writerMode = 'streamsaver';
    writerInternals.onCompleteCallback = actualSize => completed.push(actualSize);
    writerInternals.onErrorCallback = error => failures.push(error);

    await expect(writerInternals.finalize()).rejects.toThrow(
      'disk commit failed'
    );
    expect(completed).toEqual([]);
    expect(failures).toEqual([]);
  });
  it('rejects locked file-system-access writers instead of reporting completion', async () => {
    const { DirectFileWriter } = await import('./directFileWriter');
    const writer = new DirectFileWriter();
    const completed: number[] = [];
    const writerInternals = writer as unknown as {
      writer: { locked: boolean; close: () => Promise<void> };
      writerMode: 'file-system-access';
      onCompleteCallback: (actualSize: number) => void;
      finalize(): Promise<void>;
    };

    writerInternals.writer = {
      locked: true,
      close: vi.fn(async () => undefined),
    };
    writerInternals.writerMode = 'file-system-access';
    writerInternals.onCompleteCallback = actualSize => completed.push(actualSize);

    await expect(writerInternals.finalize()).rejects.toThrow(
      'File writer is locked'
    );
    expect(completed).toEqual([]);
  });
  it('allows exact-size finalization to discard duplicate buffered chunks after resume', async () => {
    const { DirectFileWriter } = await import('./directFileWriter');
    const writer = new DirectFileWriter();
    const completed: number[] = [];
    const clear = vi.fn();

    const writerInternals = writer as unknown as {
      manifest: { totalSize: number; isSizeEstimated?: boolean };
      totalSize: number;
      totalBytesWritten: number;
      reorderingBuffer: {
        getStatus: () => { bufferedCount: number; nextExpected: number };
        clear: () => void;
      };
      writer: { close: () => Promise<void> };
      writerMode: 'streamsaver';
      onCompleteCallback: (actualSize: number) => void;
      finalize(): Promise<void>;
    };
    writerInternals.manifest = { totalSize: 10, isSizeEstimated: false };
    writerInternals.totalSize = 10;
    writerInternals.totalBytesWritten = 10;
    writerInternals.reorderingBuffer = {
      getStatus: () => ({ bufferedCount: 1, nextExpected: 10 }),
      clear,
    };
    writerInternals.writer = { close: vi.fn(async () => undefined) };
    writerInternals.writerMode = 'streamsaver';
    writerInternals.onCompleteCallback = actualSize => completed.push(actualSize);

    await writerInternals.finalize();

    expect(clear).toHaveBeenCalled();
    expect(completed).toEqual([10]);
  });
  it('resetState clears reconnect waits and invalidates stale transfer waiters', async () => {
    const { SwarmManager } = await import('./swarmManager');
    const manager = new SwarmManager();

    const waiter = vi.fn();
    const managerInternals = manager as unknown as {
      awaitingReceiverReconnect: boolean;
      transferRunId: number;
      partitionAckWaiters: Map<number, { runId: number; peers: Set<string> }>;
      sendWindowWaiters: Set<() => void>;
      resetState(): void;
    };

    managerInternals.awaitingReceiverReconnect = true;
    managerInternals.transferRunId = 7;
    managerInternals.partitionAckWaiters.set(1024, {
      runId: 7,
      peers: new Set(['peer-1']),
    });
    managerInternals.sendWindowWaiters.add(waiter);

    managerInternals.resetState();

    expect(managerInternals.awaitingReceiverReconnect).toBe(false);
    expect(managerInternals.transferRunId).toBe(8);
    expect(managerInternals.partitionAckWaiters.size).toBe(0);
    expect(managerInternals.sendWindowWaiters.size).toBe(0);
    expect(waiter).toHaveBeenCalledOnce();
  });

  it('counts queued writer payload bytes before the write task executes and pauses immediately', async () => {
    const { DirectFileWriter } = await import('./directFileWriter');
    const writer = new DirectFileWriter();
    const flowActions: string[] = [];
    let unblockQueue: () => void = () => undefined;

    const packet = new ArrayBuffer(22 + 32 * 1024 * 1024);
    const view = new DataView(packet);
    view.setUint16(0, 0, true);
    view.setUint32(14, 32 * 1024 * 1024, true);

    const writerInternals = writer as unknown as {
      writeQueue: Promise<void>;
      pendingBytesInBuffer: number;
      onFlowControl(callback: (action: 'PAUSE' | 'RESUME') => void): void;
      writeChunk(packet: ArrayBuffer): Promise<void>;
    };
    writerInternals.writeQueue = new Promise(resolve => {
      unblockQueue = resolve;
    });
    writerInternals.onFlowControl(action => flowActions.push(action));

    const pendingWrite = writerInternals.writeChunk(packet).catch(() => undefined);

    expect(flowActions).toEqual(['PAUSE']);
    expect(writerInternals.pendingBytesInBuffer).toBe(32 * 1024 * 1024);

    unblockQueue();
    await pendingWrite;
    expect(flowActions).toEqual(['PAUSE']);
  });

  it('propagates Firefox File System Access AbortError instead of falling back', async () => {
    const { DirectFileWriter } = await import('./directFileWriter');
    const abortError = Object.assign(new Error('cancelled'), {
      name: 'AbortError',
    });
    const showSaveFilePicker = vi.fn(async () => {
      throw abortError;
    });

    vi.stubGlobal('navigator', { userAgent: 'Firefox' });
    vi.stubGlobal('window', { showSaveFilePicker });
    vi.stubGlobal('document', { createElement: vi.fn() });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });

    const writer = new DirectFileWriter();

    await expect(
      writer.initStorage({
        totalSize: 1,
        totalFiles: 1,
        files: [{ path: 'cancel.bin', size: 1 }],
      })
    ).rejects.toThrow('USER_CANCELLED|사용자가 파일 저장을 취소했습니다.');
    expect(showSaveFilePicker).toHaveBeenCalledOnce();
  });

  it('surfaces receiver TURN config fetch rejection to diagnostic catch', async () => {
    const { transferService } = await import('./webRTCService');
    const turnError = new Error('turn unavailable');
    signalingService.requestTurnConfig.mockRejectedValueOnce(turnError);

    const receiverInternals = transferService as unknown as {
      fetchTurnConfig(roomId: string): Promise<void>;
    };

    await expect(receiverInternals.fetchTurnConfig('room-1')).rejects.toBe(
      turnError
    );
  });

  it('drains trailing zero-byte ZIP entries before receiver ZIP finalization', async () => {
    const { DirectFileWriter } = await import('./directFileWriter');
    const writer = new DirectFileWriter();
    const zipEvents: string[] = [];

    const writerInternals = writer as unknown as {
      manifest: {
        totalSize: number;
        totalFiles: number;
        isSizeEstimated: boolean;
        files: Array<{ path: string; size: number }>;
      };
      totalSize: number;
      totalBytesWritten: number;
      writerMode: 'blob-fallback';
      blobChunks: Uint8Array[];
      receiverZipStream: {
        begin_file(path: string, size: bigint): Uint8Array;
        end_file(): Uint8Array;
        finalize(): Uint8Array;
      };
      receiverZipFileIndex: number;
      receiverZipFileBytesWritten: number;
      receiverZipFinalized: boolean;
      finalizeReceiverZip(): Promise<void>;
    };

    writerInternals.manifest = {
      totalSize: 1,
      totalFiles: 3,
      isSizeEstimated: true,
      files: [
        { path: 'nonempty.txt', size: 1 },
        { path: 'empty-a.txt', size: 0 },
        { path: 'empty-b.txt', size: 0 },
      ],
    };
    writerInternals.totalSize = 1;
    writerInternals.totalBytesWritten = 1;
    writerInternals.writerMode = 'blob-fallback';
    writerInternals.blobChunks = [];
    writerInternals.receiverZipFileIndex = 1;
    writerInternals.receiverZipFileBytesWritten = 0;
    writerInternals.receiverZipFinalized = false;
    writerInternals.receiverZipStream = {
      begin_file: (path, size) => {
        zipEvents.push(`begin:${path}:${size}`);
        return new Uint8Array([1]);
      },
      end_file: () => {
        zipEvents.push('end');
        return new Uint8Array([2]);
      },
      finalize: () => {
        zipEvents.push('finalize');
        return new Uint8Array([3]);
      },
    };

    await writerInternals.finalizeReceiverZip();

    expect(zipEvents).toEqual([
      'begin:empty-a.txt:0',
      'end',
      'begin:empty-b.txt:0',
      'end',
      'finalize',
    ]);
    expect(writerInternals.receiverZipFinalized).toBe(true);
    expect(writerInternals.receiverZipFileIndex).toBe(3);
  });
  it('does not send resume hints during an active connected foreground event', async () => {
    const { transferService } = await import('./webRTCService');
    const sentMessages: unknown[] = [];
    const requestResume = vi.fn();

    const receiverInternals = transferService as unknown as {
      roomId: string | null;
      isTransferActive: boolean;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
      peer: { connected: boolean; send(message: string): void };
      writer: { requestResumeFromCurrentOffset(reason: string): boolean };
      lastPartitionOffsetNeedingAck: number | null;
      lastPartitionRunIdNeedingAck: number | null;
      handlePageBecameActive(event?: Event): void;
    };

    receiverInternals.roomId = 'room-1';
    receiverInternals.isTransferActive = true;
    receiverInternals.reconnectTimer = null;
    receiverInternals.peer = {
      connected: true,
      send: (message: string) => {
        sentMessages.push(JSON.parse(message));
      },
    };
    receiverInternals.writer = { requestResumeFromCurrentOffset: requestResume };
    receiverInternals.lastPartitionOffsetNeedingAck = 1024;
    receiverInternals.lastPartitionRunIdNeedingAck = 3;

    receiverInternals.handlePageBecameActive();

    expect(sentMessages).toEqual([]);
    expect(requestResume).not.toHaveBeenCalled();
  });
});
