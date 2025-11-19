/**
 * We include the worker code as a string to avoid build configuration issues
 * in this specific generation environment. 
 */
export const workerScript = `
  let file = null;
  let offset = 0;
  let chunkSize = 16384; // 16KB default
  let fileHandle = null;
  let writable = null;

  self.onmessage = async (e) => {
    const { command, payload } = e.data;

    if (command === 'START_READ') {
      file = payload.file;
      offset = 0;
      chunkSize = payload.chunkSize || 16384;
      readNextChunk();
    } 
    
    else if (command === 'NEXT_CHUNK') {
      // Dynamic chunk sizing adjustment could happen here based on backpressure
      if (payload && payload.adjustSize) {
         chunkSize = payload.adjustSize;
      }
      readNextChunk();
    }

    else if (command === 'INIT_WRITE') {
      try {
        // OPFS Support Check
        if (!navigator.storage || !navigator.storage.getDirectory) {
           throw new Error("OPFS not supported");
        }
        const root = await navigator.storage.getDirectory();
        fileHandle = await root.getFileHandle(payload.fileName, { create: true });
        writable = await fileHandle.createWritable();
        self.postMessage({ type: 'INIT_OPFS_SUCCESS' });
      } catch (err) {
        self.postMessage({ type: 'ERROR', payload: err.message });
      }
    }

    else if (command === 'WRITE_CHUNK') {
      if (writable) {
        try {
          await writable.write(payload.data);
          self.postMessage({ type: 'CHUNK_WRITTEN', payload: { size: payload.data.byteLength }});
        } catch (err) {
          self.postMessage({ type: 'ERROR', payload: err.message });
        }
      }
    }
    
    else if (command === 'FINISH_WRITE') {
      if (writable) {
        await writable.close();
        self.postMessage({ type: 'COMPLETE' });
      }
    }
  };

  function readNextChunk() {
    if (!file) return;

    if (offset >= file.size) {
      self.postMessage({ type: 'COMPLETE' });
      return;
    }

    const slice = file.slice(offset, offset + chunkSize);
    const reader = new FileReader();
    
    reader.onload = (e) => {
      if (e.target && e.target.result) {
        const arrayBuffer = e.target.result;
        offset += arrayBuffer.byteLength;
        
        // Transfer the ArrayBuffer to main thread to avoid copy overhead
        self.postMessage(
          { type: 'CHUNK', payload: { data: arrayBuffer, offset, total: file.size } }, 
          [arrayBuffer]
        );
      }
    };
    
    reader.onerror = (err) => {
       self.postMessage({ type: 'ERROR', payload: 'File read error' });
    };

    reader.readAsArrayBuffer(slice);
  }
`;

export const getWorkerBlobUrl = () => {
  const blob = new Blob([workerScript], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
};