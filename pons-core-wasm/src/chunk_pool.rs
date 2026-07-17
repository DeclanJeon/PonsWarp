use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct ChunkPool {
    pool: Vec<Vec<u8>>,
    chunk_size: usize,
    max_pool_size: usize,
}

#[wasm_bindgen]
impl ChunkPool {
    #[wasm_bindgen(constructor)]
    pub fn new(chunk_size: usize, max_pool_size: usize) -> Self {
        Self {
            pool: Vec::with_capacity(max_pool_size),
            chunk_size,
            max_pool_size,
        }
    }

    pub fn acquire(&mut self) -> Vec<u8> {
        self.pool
            .pop()
            .unwrap_or_else(|| vec![0u8; self.chunk_size])
    }

    pub fn release(&mut self, mut buffer: Vec<u8>) {
        if self.pool.len() < self.max_pool_size {
            buffer.fill(0);
            self.pool.push(buffer);
        }
    }

    pub fn clear(&mut self) {
        self.pool.clear();
    }

    #[wasm_bindgen(getter)]
    pub fn pool_size(&self) -> usize {
        self.pool.len()
    }

    #[wasm_bindgen(getter)]
    pub fn chunk_size(&self) -> usize {
        self.chunk_size
    }

    pub fn preallocate(&mut self, count: usize) {
        let to_allocate = count.min(self.max_pool_size - self.pool.len());
        for _ in 0..to_allocate {
            self.pool.push(vec![0u8; self.chunk_size]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_acquire_release() {
        let mut pool = ChunkPool::new(1024, 10);

        assert_eq!(pool.pool_size(), 0);

        let buf1 = pool.acquire();
        assert_eq!(buf1.len(), 1024);
        assert_eq!(pool.pool_size(), 0);

        pool.release(buf1);
        assert_eq!(pool.pool_size(), 1);

        let buf2 = pool.acquire();
        assert_eq!(buf2.len(), 1024);
        assert_eq!(pool.pool_size(), 0);
    }

    #[test]
    fn test_max_pool_size() {
        let mut pool = ChunkPool::new(1024, 2);

        let buf1 = pool.acquire();
        let buf2 = pool.acquire();
        let buf3 = pool.acquire();

        pool.release(buf1);
        pool.release(buf2);
        pool.release(buf3); // Should be dropped, not added to pool

        assert_eq!(pool.pool_size(), 2);
    }

    #[test]
    fn test_preallocate() {
        let mut pool = ChunkPool::new(1024, 10);
        pool.preallocate(5);
        assert_eq!(pool.pool_size(), 5);
    }
}
