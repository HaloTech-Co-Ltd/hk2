/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo 软件的发明人同时也是知识产权
 * 权利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不
 * 限于文字、图片、音频、视频、图表、界面设计、版面框架、有关数据或电子文档等）
 * 均受中华人民共和国法律法规和相应的国际条约保护，易景科技享有上述知识
 * 产权，但权利人依照法律规定所享有的权利除外。未免疑义，本条所指的"知识
 * 产权"是指任何及所有基于 Halo 软件产生的：（a）版权、商标、商号、域名、与
 * 商标和商号相关的商誉、设计和专利；与创新、技术诀窍、保密技术、秘密技术、非
 * 技术信息相关的权利；（b）人身权、掩模作品权、署名权和发表权；以及（c）在
 * 本协议生效之前已存在或此后出现在世界任何地方的其他工业产权、专有权、与"知识
 * 产权"相关的上述权利和上述权利的所有续期和延长，无论此类权利是否已在相关
 * 法域内的相关机构注册。
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. Except as expressly permitted
 * in your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part of this software, in any
 * form or by any means. Reverse engineering, disassembly, or decompilation
 * of this software, unless required by law for interoperability, is
 * prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications or applications that
 * could create a risk of personal injury. It is the user's responsibility
 * to use, operate, and maintain this software in accordance with the
 * instructions in the user manual and other documentation provided with
 * the software.
 *
 *-------------------------------------------------------------------------
 */

/**
 * Transient-error retry for LLM request ESTABLISHMENT. A long agent turn
 * with a 100k+ token body is exactly where a momentary network hiccup
 * (connection reset / DNS blip / keepalive race) kills the whole turn with
 * 'fetch failed' — after minutes of streaming work. Retrying the connection
 * setup a couple of times is safe: the request body is identical and the
 * server treats a re-POST as a fresh call. Streaming responses are NOT
 * retried here (once headers arrive, mid-stream failures are surface-level
 * and handled by the caller's error path); only the pre-header phase.
 *
 * Retried errors, split by whether the server can have SEEN the request:
 *   - SAFE (request never left / response arrived): connection-establishment
 *     failures (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, undici
 *     UND_ERR_CONNECT_TIMEOUT) and HTTP 429/502/503/504 (429/503 honor
 *     Retry-After). Retrying these cannot duplicate work.
 *   - UNKNOWN OUTCOME (mid-flight): ECONNRESET / ETIMEDOUT / EPIPE /
 *     socket hang up after the request was sent — the server may have
 *     received and EXECUTED the POST (duplicate request / duplicate billing).
 *     Retrying these is OPT-IN: HK2_LLM_RETRY_UNKNOWN_POST=1. Default off.
 *   - Deterministic failures (invalid URL, 4xx other than 429) fail on
 *     attempt 1 — no backoff penalty.
 * Providers here expose no idempotency key, so classification is the only
 * duplicate-request guard; the opt-in flag makes the trade-off explicit.
 *
 * Backoff: exponential with FULL jitter (uniform in [base/2, base]) so many
 * clients hitting a recovered endpoint don't retry in lockstep. Sleeps are
 * abort-aware — a user interrupt during the backoff window rejects at once.
 * An optional onRetry(attempt, delayMs, err) lets the UI surface
 * 'retrying model request · attempt 2/3' instead of looking stuck.
 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

/**
 * Classify a fetch exception:
 *   'establish' — the request never went out (refused / DNS / connect
 *                 timeout): always safe to retry.
 *   'unknown'   — the request may have been delivered (reset / timeout /
 *                 pipe / socket hang up mid-flight): retry is opt-in.
 *   null        — deterministic (invalid URL, programming error): never.
 */
function classifyFetchError(err) {
  if (!err) return null;
  const code = String(err.cause?.code || '');
  if (/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)$/.test(code)) return 'establish';
  const msg = `${err.message || ''} ${err.cause?.message || ''} ${code}`;
  if (/ECONNRESET|ETIMEDOUT|EPIPE|ECONNABORTED|UND_ERR_SOCKET|socket hang up|fetch failed/i.test(msg)) {
    return 'unknown';
  }
  return null;
}

/** HK2_LLM_RETRY_UNKNOWN_POST=1 opts into retrying unknown-outcome POSTs. */
function retryUnknownEnabled() {
  return (process.env.HK2_LLM_RETRY_UNKNOWN_POST ?? '').trim() === '1';
}

/** Parse a Retry-After header (delta-seconds or HTTP-date); null if absent/bad. */
function retryAfterMs(header) {
  if (!header) return null;
  const s = Number(String(header).trim());
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, MAX_DELAY_MS);
  const date = Date.parse(String(header).trim());
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), MAX_DELAY_MS));
  return null;
}

/** Abort-aware sleep: rejects immediately when the signal fires. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function fetchWithRetry(url, init, { attempts = ATTEMPTS, onRetry } = {}) {
  let lastErr = null;
  let delayOverride = null; // Retry-After from the previous 429/503
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const exp = Math.min(BASE_DELAY_MS * Math.pow(2, i - 1), MAX_DELAY_MS);
      // Full jitter: uniform in [exp/2, exp] — decorrelated across clients.
      const delay = delayOverride ?? Math.round(exp / 2 + Math.random() * (exp / 2));
      delayOverride = null;
      if (onRetry) { try { onRetry(i, delay, lastErr, attempts); } catch { /* listener error must not break the retry */ } }
      try {
        await sleep(delay, init?.signal);
      } catch (err) {
        throw err; // aborted during backoff — surface the interrupt
      }
    }
    try {
      const resp = await fetch(url, init);
      if (!RETRYABLE_STATUS.has(resp.status) || i === attempts - 1) return resp;
      // Drain the retryable response body so the connection can be reused.
      const ra = resp.headers?.get?.('retry-after');
      await resp.text().catch(() => {});
      delayOverride = retryAfterMs(ra);
      lastErr = new Error(`HTTP ${resp.status}`);
      continue;
    } catch (err) {
      lastErr = err;
      if (init?.signal?.aborted) throw err; // user interrupt: never retry
      const kind = classifyFetchError(err);
      if (kind === null) throw err; // deterministic: fail now
      // Unknown-outcome failures (the POST may have been executed server-side)
      // are only retried when the user opted in — duplicate requests and
      // duplicate billing are worse than a failed turn.
      if (kind === 'unknown' && !retryUnknownEnabled()) throw err;
      if (i === attempts - 1) throw err;
    }
  }
  throw lastErr;
}
