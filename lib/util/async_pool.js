/**
 * 有界concurrency执行pool：给定 items array与 mapper，最多 concurrency 个concurrency。
 *
 * @template T, R
 * @param {Array<T>} items
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @param {number} concurrency
 * @param {(progress: { done: number, total: number }) => void} [onProgress]
 * @returns {Promise<Array<R>>}
 */
export async function asyncPool(items, mapper, concurrency = 8, onProgress) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const total = items.length;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= total) return;
      try {
        results[idx] = await mapper(items[idx], idx);
      } catch (err) {
        results[idx] = { __error: err };
      }
      done++;
      if (onProgress) {
        try { onProgress({ done, total }); } catch (_) { /* noop */ }
      }
    }
  }

  const workers = [];
  const n = Math.max(1, Math.min(concurrency, total));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export default asyncPool;
