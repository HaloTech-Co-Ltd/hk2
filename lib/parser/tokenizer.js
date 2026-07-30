/**
 * C 源码字面量剥离：注释 / 字符串 / 字符常量。
 * 输出：与输入等长的字符串，被剥离处替换为等长的空白（保留 '\n' 以维持行号）。
 *
 * 同时返回每行起始位置 → 用于把字符 offset 映射回 1-based 行号。
 */

/**
 * @param {string} src
 * @returns {{ stripped: string, lineStarts: number[] }}
 */
export function stripLiterals(src) {
  const n = src.length;
  const out = new Array(n);
  let i = 0;

  // 行号映射
  const lineStarts = [0];
  for (let k = 0; k < n; k++) {
    if (src.charCodeAt(k) === 10) lineStarts.push(k + 1);
  }

  while (i < n) {
    const c = src[i];
    const c1 = src[i + 1];

    // 行注释 //
    if (c === '/' && c1 === '/') {
      out[i++] = ' '; out[i++] = ' ';
      while (i < n && src.charCodeAt(i) !== 10) { out[i++] = ' '; }
      continue;
    }
    // 块注释 /* */
    if (c === '/' && c1 === '*') {
      out[i++] = ' '; out[i++] = ' ';
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out[i++] = src[i] === '\n' ? '\n' : ' ';
      }
      if (i < n) { out[i++] = ' '; if (i < n) out[i++] = ' '; }
      continue;
    }
    // 字符串 "..."（支持 \" \\）
    if (c === '"') {
      out[i++] = ' ';
      while (i < n && src.charCodeAt(i) !== 34) {
        if (src[i] === '\\' && i + 1 < n) {
          out[i++] = src[i] === '\n' ? '\n' : ' ';
          out[i++] = src[i] === '\n' ? '\n' : ' ';
        } else {
          out[i++] = src[i] === '\n' ? '\n' : ' ';
        }
      }
      if (i < n) out[i++] = ' ';
      continue;
    }
    // 字符常量 '...'
    if (c === "'") {
      out[i++] = ' ';
      while (i < n && src.charCodeAt(i) !== 39) {
        if (src[i] === '\\' && i + 1 < n) {
          out[i++] = src[i] === '\n' ? '\n' : ' ';
          out[i++] = src[i] === '\n' ? '\n' : ' ';
        } else {
          out[i++] = src[i] === '\n' ? '\n' : ' ';
        }
      }
      if (i < n) out[i++] = ' ';
      continue;
    }
    out[i++] = c;
  }

  return { stripped: out.join(''), lineStarts };
}

/**
 * 把 offset 映射到 1-based 行号。lineStarts 必须升序。
 */
export function offsetToLine(lineStarts, offset) {
  // 二分
  let lo = 0, hi = lineStarts.length - 1;
  if (offset < 0) return 1;
  if (offset >= lineStarts[hi]) return hi + 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
