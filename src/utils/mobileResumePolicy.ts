export type ReceiverReconnectPolicyInput = {
  isTransferActive: boolean;
  hasRoom: boolean;
  hasWriter: boolean;
  fileCount: number;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  pageHidden: boolean;
};

export function shouldKeepReceiverReconnectAlive(
  input: ReceiverReconnectPolicyInput
): boolean {
  if (
    !input.isTransferActive ||
    !input.hasRoom ||
    !input.hasWriter ||
    input.fileCount <= 0
  ) {
    return false;
  }

  if (input.reconnectAttempts < input.maxReconnectAttempts) {
    return true;
  }

  return input.pageHidden;
}

export type PartitionedResumeCursorInput = {
  fileSizes: number[];
  startOffset: number;
  chunkSize: number;
  partitionSize: number;
  totalSize: number;
};

export type PartitionedResumeCursor = {
  fileIndex: number;
  fileOffset: number;
  globalOffset: number;
  sequence: number;
  nextPartitionEnd: number;
};

export function getPartitionedResumeCursor(
  input: PartitionedResumeCursorInput
): PartitionedResumeCursor {
  const safeStartOffset = Math.min(
    Math.max(0, Math.floor(input.startOffset)),
    Math.max(0, input.totalSize)
  );

  let fileIndex = 0;
  let bytesBeforeFile = 0;
  while (
    fileIndex < input.fileSizes.length &&
    bytesBeforeFile + input.fileSizes[fileIndex] <= safeStartOffset
  ) {
    bytesBeforeFile += input.fileSizes[fileIndex];
    fileIndex++;
  }

  const partitionNumber = Math.floor(safeStartOffset / input.partitionSize) + 1;

  return {
    fileIndex,
    fileOffset: Math.max(0, safeStartOffset - bytesBeforeFile),
    globalOffset: safeStartOffset,
    sequence: Math.floor(safeStartOffset / input.chunkSize),
    nextPartitionEnd: Math.min(
      partitionNumber * input.partitionSize,
      input.totalSize
    ),
  };
}
