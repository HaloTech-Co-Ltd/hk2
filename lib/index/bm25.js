/**
 * BM25 倒排index。无外部依赖，纯memory Map + JSON 持久化。
 *
 * 存储：
 *   inverted.json: { token: [[symbolId, tf], ...] }
 *   stats.json:    { N, avgdl, df: {token: count}, docLen: {symbolId: len} }
 *
 * queryhour全memoryquery（lazy load）。
 */

const K1 = 1.5;
const B = 0.75;

export class BM25Index {
  constructor() {
    /** @type {Map<string, Map<string, number>>} token -> (symbolId -> tf) */
    this.postings = new Map();
    /** @type {Map<string, number>} symbolId -> docLen */
    this.docLen = new Map();
    /** @type {Map<string, number>} token -> df */
    this.df = new Map();
    this.N = 0;
    this.avgdl = 0;
  }

  /**
   * add一个文档（symbol）。
   * @param {string} symbolId
   * @param {string[]} tokens  已经加权后的 tokens
   */
  addDoc(symbolId, tokens) {
    if (!symbolId || tokens.length === 0) return;
    const tfLocal = new Map();
    for (const t of tokens) tfLocal.set(t, (tfLocal.get(t) || 0) + 1);
    for (const [t, tf] of tfLocal) {
      let posting = this.postings.get(t);
      if (!posting) { posting = new Map(); this.postings.set(t, posting); }
      posting.set(symbolId, tf);
      this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.docLen.set(symbolId, tokens.length);
    this.N++;
  }

  removeDoc(symbolId) {
    const len = this.docLen.get(symbolId);
    if (len === undefined) return;
    // 需要遍历 postings 找出包含 symbolId 的 token —— 代价较高，仅在incremental重建hour用
    for (const [t, posting] of this.postings) {
      if (posting.has(symbolId)) {
        posting.delete(symbolId);
        const newDf = (this.df.get(t) || 1) - 1;
        if (newDf <= 0) { this.df.delete(t); this.postings.delete(t); }
        else this.df.set(t, newDf);
      }
    }
    this.docLen.delete(symbolId);
    this.N--;
  }

  finalize() {
    let total = 0;
    for (const len of this.docLen.values()) total += len;
    this.avgdl = this.N > 0 ? total / this.N : 0;
  }

  /**
   * @param {string[]} queryTokens
   * @param {{topK?: number, restrictTo?: Set<string>}} [opts]
   * @returns {Array<{symbolId: string, score: number}>}
   */
  query(queryTokens, opts = {}) {
    if (this.N === 0 || queryTokens.length === 0) return [];
    const topK = opts.topK ?? 100;
    const restrictTo = opts.restrictTo ?? null;
    const scores = new Map();
    const k1 = K1, b = B;
    const seen = new Set();   // 去重 query token

    for (const token of queryTokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      const posting = this.postings.get(token);
      if (!posting) continue;
      const df = this.df.get(token) || 0;
      if (df === 0) continue;
      const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
      for (const [symbolId, tf] of posting) {
        if (restrictTo && !restrictTo.has(symbolId)) continue;
        const dl = this.docLen.get(symbolId) || this.avgdl;
        const denom = tf + k1 * (1 - b + b * (dl / (this.avgdl || 1)));
        const contrib = idf * (tf * (k1 + 1)) / (denom || 1);
        scores.set(symbolId, (scores.get(symbolId) || 0) + contrib);
      }
    }

    const arr = Array.from(scores.entries()).map(([symbolId, score]) => ({ symbolId, score }));
    arr.sort((a, b) => b.score - a.score);
    return arr.slice(0, topK);
  }

  serialize() {
    /** 把 Map<token, Map<symbolId, tf>> serialize为 { token: [[symbolId, tf], ...] } */
    const inverted = {};
    for (const [t, posting] of this.postings) {
      inverted[t] = Array.from(posting.entries());
    }
    const dfObj = {};
    for (const [t, c] of this.df) dfObj[t] = c;
    const docLenObj = {};
    for (const [sid, l] of this.docLen) docLenObj[sid] = l;
    return {
      N: this.N, avgdl: this.avgdl || 0,
      df: dfObj, docLen: docLenObj,
      inverted,
    };
  }

  static deserialize(obj) {
    const idx = new BM25Index();
    idx.N = obj.N || 0;
    idx.avgdl = obj.avgdl || 0;
    for (const [t, c] of Object.entries(obj.df || {})) idx.df.set(t, c);
    for (const [sid, l] of Object.entries(obj.docLen || {})) idx.docLen.set(sid, l);
    for (const [t, list] of Object.entries(obj.inverted || {})) {
      const m = new Map();
      for (const [sid, tf] of list) m.set(sid, tf);
      idx.postings.set(t, m);
    }
    return idx;
  }
}

export default BM25Index;
