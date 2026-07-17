export const getSenderWorker = (): Worker => {
  return new Worker(
    new URL('../workers/file-sender.worker.ts', import.meta.url),
    { type: 'module' }
  );
};

export const getReceiverWorker = (): Worker => {
  return new Worker(
    new URL('../workers/file-receiver.worker.ts', import.meta.url),
    { type: 'module' }
  );
};

export const getSenderWorkerV1 = (): Worker => {
  return getSenderWorker();
};

export const getReceiverWorkerV1 = (): Worker => {
  return getReceiverWorker();
};
