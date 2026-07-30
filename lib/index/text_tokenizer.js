/**
 * Text tokenizer for BM25 indexing and querying.
 *
 * Features:
 * - Split snake_case and camelCase: heap_insert → [heap, insert]; heapInsert → [heap, insert]
 * - English stemming: inserted/inserting/inserts → insert; acquires/acquired/acquire → acquire
 * - CJK bigrams: 堆元组插入 → [堆元, 元组, 组插, 插入]
 * - Stop-word filter: where/is/the/that/function etc.
 * - Lower-case everything
 *
 * At query time (expandQuery=true): Chinese terms are additionally mapped to English (see cn_en_dict.js)
 */

import { expandChineseTerms } from './cn_en_dict.js';

// 英文停用词（高频、低区minute度）
const STOP_WORDS = new Set([
  // EN
  'a','an','the','this','that','these','those',
  'is','are','was','were','be','been','being','am',
  'do','does','did','doing','done',
  'have','has','had','having',
  'will','would','shall','should','can','could','may','might','must',
  'and','or','but','not','no','nor','so','yet',
  'as','at','by','for','from','in','into','of','on','onto','to','with','within','without',
  'about','above','after','before','between','through','under','until','up','down','out',
  'where','when','why','how','what','which','who','whom','whose',
  'if','then','else','while','during',
  'i','you','he','she','it','we','they','me','him','her','us','them',
  'my','your','his','its','our','their',
  'function','functions','method','methods','variable','variables',
  'use','used','using','uses',
  'one','two','three','first','second','third',
  'some','any','all','each','every','both',
  'there','here',
  // ZH（单字常见虚词，bigram hour基本不会单独成词；保留以备后用）
  '的','了','是','在','和','与','或','上','下','里','中','等','个','些','这','那','就','都','也','而','及','以','为','被','把','给','向','从','到','对','于',
]);

const SUFFIX_RULES = [
  // sequential：从长到短
  // -ingly / -edly / -ing
  [/^(.+?)ingly$/, (m) => m[1].length >= 3 ? m[1] : null],
  [/^(.+?)edly$/, (m) => m[1]],
  [/^(.+?)ing$/, (m) => m[1].length >= 3 ? m[1] : null],
  // -ed：strip 后若剩双辅音（committ→commit, fitt→fit）则去重；保留 ss/ll
  [/^(.+?)ed$/, (m) => {
    if (m[1].length < 2) return null;
    return m[1].replace(/([^aeiousl])\1$/, '$1');
  }],
  // -ies → y
  [/^(.+?[^aeiou])ies$/, (m) => m[1] + 'y'],
  // -ses / -xes / -zes → 去单数
  [/^(.+?)(ses|xes|zes)$/, (m) => m[1]],
  // -es
  [/^(.+?[^s])es$/, (m) => m[1]],
  // -s
  [/^(.+?[^s])s$/, (m) => m[1]],
  // -er / -ers / -or / -ors（执行者，与动词同源）
  [/^(.+?)(er|ers|or|ors)$/, (m) => m[1].length >= 3 ? m[1] : null],
  // -ly
  [/^(.+?)ly$/, (m) => m[1]],
  // -ment / -ness（抽象名词）
  [/^(.+?)(ment|ness)$/, (m) => m[1].length >= 3 ? m[1] : null],
];

/**
 * 英文单词基本归一化（轻量词干提取，Porter 风格迭代）。
 * 多次应用规则直到稳定，使 "registrations"/"registration"/"register" 都归一到 "regist"。
 */
function stem(word) {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  for (let iter = 0; iter < 3; iter++) {
    let changed = false;
    for (const [re, fn] of SUFFIX_RULES) {
      const m = re.exec(w);
      if (m) {
        const stemmed = fn(m);
        if (stemmed && stemmed.length >= 3 && stemmed !== w) {
          w = stemmed;
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  return w;
}

/**
 * Project-specific abbreviation expansions. Empty by default; projects can
 * populate via ~/.hk2/kb/<projectId>/abbreviations.json (a future feature).
 *
 * The hardcoded PG_PREFIX_VARIANTS map was removed when hk2 became a
 * general-purpose coding agent — projects that want custom term expansion
 * can supply their own dictionary.
 */
const PROJECT_PREFIX_VARIANTS = {};

/**
 * queryhour形态变体扩展。
 * 原因：词干提取无法保证 query 与 index 归一到同一形态（如 "registration" vs index中的 "register"→"regist"）。
 * 该function对每个 query token 额外generate常见动词/名词变体，让 BM25 能命中index中的任意形态。
 */
export function expandQueryVariants(token) {
  const variants = new Set([token]);
  const w = token.toLowerCase();
  if (w.length >= 3) {
    const pgVariants = PROJECT_PREFIX_VARIANTS[w];
    if (pgVariants) for (const v of pgVariants) variants.add(v);
  }
  if (w.length >= 4) {
    // 沿用 SUFFIX_RULES 单步剥离，generateall可能的"前缀"
    for (const [re, fn] of SUFFIX_RULES) {
      const m = re.exec(w);
      if (m) {
        const s = fn(m);
        if (s && s.length >= 3) {
          variants.add(s);
          const pgStem = PROJECT_PREFIX_VARIANTS[s];
          if (pgStem) for (const v of pgStem) variants.add(v);
        }
      }
    }
    // -ation / -ition / -ion 特殊处理：registration → regist（去末尾 r）+ regist
    let m;
    if ((m = /^(.+?)(ation|ition)$/.exec(w)) && m[1].length >= 3) {
      variants.add(m[1]);
      if (m[1].endsWith('r')) variants.add(m[1].slice(0, -1));
      variants.add(m[1] + 'e');
    }
    if ((m = /^(.+?[^aeiou])ion$/.exec(w)) && m[1].length >= 3) {
      variants.add(m[1]);
    }
    // -ity
    if ((m = /^(.+?)ity$/.exec(w)) && m[1].length >= 3) {
      variants.add(m[1]);
      variants.add(m[1] + 'e');
    }
    // -ate / -ation 配对
    if ((m = /^(.+?)ate$/.exec(w)) && m[1].length >= 3) {
      variants.add(m[1]);
    }
  }
  return Array.from(variants);
}

/**
 * 提取 CJK bigram。汉字范围（含扩展 A 区）。
 */
function cjkBigrams(text) {
  const result = [];
  const chars = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    // CJK 统一汉字、扩展 A、B
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x20000 && code <= 0x2A6DF)) {
      chars.push(ch);
    } else {
      // edge界：把累积的 CJK 字符做 bigram
      if (chars.length >= 2) {
        for (let i = 0; i < chars.length - 1; i++) {
          result.push(chars[i] + chars[i+1]);
        }
      } else if (chars.length === 1) {
        result.push(chars[0]);
      }
      chars.length = 0;
    }
  }
  // footer
  if (chars.length >= 2) {
    for (let i = 0; i < chars.length - 1; i++) {
      result.push(chars[i] + chars[i+1]);
    }
  } else if (chars.length === 1) {
    result.push(chars[0]);
  }
  return result;
}

/**
 * 主minute词入口。
 * @param {string} text
 * @param {{expandQuery?: boolean}} [opts]  expandQuery=true hourenable CN→EN query扩展
 */
export function tokenizeText(text, opts = {}) {
  if (!text) return [];
  const tokens = [];

  // 1. 抽取 CJK 段，做 bigram + optional CN→EN 扩展
  const cjkSegments = [];
  const cleanedCjk = text.replace(/[一-鿿㐀-䶿]+/g, (m) => {
    cjkSegments.push(m);
    return ' ';
  });
  for (const seg of cjkSegments) {
    for (const bg of cjkBigrams(seg)) {
      if (!STOP_WORDS.has(bg)) tokens.push(bg);
    }
  }

  // query扩展：把中文术语映射为英文（同样需要走 snake_case/camelCase 拆minute）
  if (opts.expandQuery) {
    const enExpansions = expandChineseTerms(text);
    for (const w of enExpansions) {
      const lower = w.toLowerCase();
      if (lower.length < 2) continue;
      // 多词/含下划线的扩展项要拆minute（如 "pg_class_aclcheck" → ["pg","class","acl","check"]）
      const parts = lower.match(/[a-z]+|[0-9]+/g) || [lower];
      for (const p of parts) {
        if (p.length < 2) continue;
        if (STOP_WORDS.has(p)) continue;
        const stemmed = stem(p);
        if (STOP_WORDS.has(stemmed)) continue;
        tokens.push(stemmed);
      }
    }
  }

  // 2. ASCII partial：拆 snake/camel/number
  const cleaned = cleanedCjk.replace(/[^A-Za-z0-9_]+/g, ' ');
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw) continue;
    const parts = raw.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g);
    if (!parts) continue;
    for (const p of parts) {
      if (/^\d+$/.test(p)) {
        if (p.length >= 1) tokens.push(p);
        continue;
      }
      const lower = p.toLowerCase();
      if (lower.length < 2) continue;
      if (STOP_WORDS.has(lower)) continue;
      const stemmed = stem(lower);
      if (STOP_WORDS.has(stemmed)) continue;
      tokens.push(stemmed);
    }
  }

  return tokens;
}

/**
 * 给定一个symbol，组合 name + signature + body 后minute词。
 * namepartial会重复加权（在 BM25 中由call方控制）。
 */
export function tokenizeSymbol(symbol) {
  const nameTokens = tokenizeText(symbol.name || '');
  const sigTokens = tokenizeText(symbol.signature || '');
  const bodyTokens = symbol.body ? tokenizeText(symbol.body.slice(0, 8192)) : [];
  // name tokens 重复 3 次以加权；signature 重复 2 次
  return [
    ...nameTokens, ...nameTokens, ...nameTokens,
    ...sigTokens, ...sigTokens,
    ...bodyTokens,
  ];
}

export default tokenizeText;
