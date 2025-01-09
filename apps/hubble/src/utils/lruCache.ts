/**
 * A simple LRU cache implementation that uses a double-buffer to store the keys and values.
 *
 * The "current" buffer is used to store the most recently accessed keys and values. When the
 * "current" buffer is full, the existing "prev" buffer is dropped, (dropping the least used
 * keys), the current buffer is moved to the "prev" buffer and a new "current" buffer is created.
 *
 * The "get" method also accepts a function that will be called if the key is not found in the cache.
 *
 * If a key is not found in the current buffer, but it is in the "prev" buffer, it is moved to the
 * current buffer.
 */
export class LRUCache<K, T> {
  current: Map<K, T>;
  prev: Map<K, T>;

  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.current = new Map();
    this.prev = new Map();
  }

  /**
   * Get the value associated with the given key. If the key is not found in the cache, the
   * provided function is called to get the value.
   *
   * If the get function throws, the key is not added to the cache.
   * and this function will throw the same error.
   *
   * @param key The key to lookup
   * @param fn The function to call if the key is not found in the cache
   */
  async get(key: K, fn: () => Promise<T> | T): Promise<T> {
    // First check if we need to rotate the buffers
    if (this.current.size >= this.maxSize) {
      // Rotate the buffers
      this.prev = this.current;
      this.current = new Map();
    }

    let value = this.current.get(key);
    if (value === undefined) {
      value = this.prev.get(key);
      if (value !== undefined) {
        this.prev.delete(key);
        this.current.set(key, value);
      } else {
        value = await fn();
        this.current.set(key, value);
      }
    }

    return value;
  }

  /**
   * Invalidate the given key in the cache.
   */
  invalidate(key: K): void {
    this.current.delete(key);
    this.prev.delete(key);
  }

  /** Clear */
  clear(): void {
    this.current.clear();
    this.prev.clear();
  }
}
