/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * （版权声明与其他源文件一致，此处省略正文以保持简洁。）
 *
 *-------------------------------------------------------------------------*/

/**
 * Resolve the KB index parse-pool concurrency.
 *
 * kb 索引在解析（parse）阶段是有界的并行执行（见 lib/index/indexer.js 与
 * lib/util/async_pool.js）。并行度通过本模块解析，规则如下（优先级从高到低）：
 *
 *   1. 显式传入的 `concurrency`（如调用方 / 测试直接指定）
 *   2. 环境变量 `HK2_INDEX_PARALLEL`
 *        - 未设置 / 空串 / `0` / 负数 / 非法值 → 自动（取 CPU 数）
 *        - 正整数 N                          → 取 N
 *   3. 自动 → `os.availableParallelism()`（Node 18.14+），
 *             否则回退 `os.cpus().length`，再回退常量 4
 *
 * 返回值始终为 >= 1 的整数。默认（`HK2_INDEX_PARALLEL` 未设置）即“自动方式”
 * ——取当前系统的 CPU 数，从而在大项目上充分利用多核。
 */
import os from 'node:os';

/**
 * @param {object} [deps]
 * @param {number} [deps.concurrency]   显式覆盖；优先级最高
 * @param {object} [deps.env]           环境变量来源（默认 process.env），便于测试注入
 * @param {() => number} [deps.cpus]    返回自动并发度的函数，便于测试注入
 * @returns {number}                    并行度，>= 1
 */
export function resolveIndexConcurrency(deps = {}) {
  if (typeof deps.concurrency === 'number' && deps.concurrency > 0) {
    return Math.max(1, Math.floor(deps.concurrency));
  }

  const env = deps.env ?? process.env;
  const raw = env.HK2_INDEX_PARALLEL;
  if (raw !== undefined && raw !== '') {
    // Strict integer parse: reject scientific notation ('1e3' → Number=1000 but
    // parseInt=1, which is surprising), floats-with-decimal-point are floored.
    const trimmed = String(raw).trim();
    if (/^[+-]?\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (Number.isFinite(n) && n > 0) {
        return Math.max(1, Math.floor(n));
      }
    }
  }

  const getCpus = deps.cpus ?? defaultCpuCount;
  return Math.max(1, getCpus());
}

/**
 * 自动并发度：优先 `os.availableParallelism()`（Node 18.14+，
 * 考虑了 cgroup / 容器 CPU 配额），回退 `os.cpus().length`，再回退 4。
 */
function defaultCpuCount() {
  if (typeof os.availableParallelism === 'function') {
    try {
      const n = os.availableParallelism();
      if (n > 0) return n;
    } catch { /* fall through */ }
  }
  const c = os.cpus();
  return (c && c.length) || 4;
}

export default resolveIndexConcurrency;
