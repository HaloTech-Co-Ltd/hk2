/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。易景科技是Halo 软件的知识产权，以及与本软件相关的所有信息内容（包
 * 括但不限于文字、图片、音频、视频、图表、界面设计、版面框架、有关数据或
 * 电子文档等）均受中华人民共和国法律法规和相应的国际条约保护，易景科技享
 * 有上述知识产 权，但相关权利人依照法律规定应享有的权利除外。
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. Except as expressly permitted
 * in your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 *-------------------------------------------------------------------------*/

/**
 * Multimodal attachments: turn local image / video / audio files (or remote
 * URLs) into OpenAI-style multimodal content blocks for models configured
 * with --multimodal=on (currently glm-5.3-flash, BigModel).
 *
 * Wire shape (per the BigModel chat/completions VLM API):
 *   messages[].content = [
 *     { type: 'text', text: '...' },
 *     { type: 'image_url', image_url: { url: 'https://... | data:image/png;base64,...' } },
 *     { type: 'video_url', video_url: { url: 'data:video/mp4;base64,...' } },
 *     { type: 'input_audio', input_audio: { data: '<base64>', format: 'wav' } },
 *   ]
 *
 * Remote URLs pass through as-is (the provider fetches them). LOCAL files
 * are read and encoded as Base64 Data URLs (requirement: 本地图片/视频/语音
 * 需要编码为 Base64 Data).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Default upload size cap per local attachment: 20 MB before Base64. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Extension → media classification. Order matters where several extensions
 * could collide (none here), and unknown extensions are rejected with a
 * clear message instead of being guessed.
 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.m4v']);
const AUDIO_EXTS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac', '.opus']);

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.webm': 'video/webm', '.flv': 'video/x-flv',
  '.m4v': 'video/x-m4v',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.opus': 'audio/opus',
};

/** Media class of a path/URL by extension; null when unknown. */
export function mediaClassOf(p) {
  const ext = path.extname(String(p || '').split('?')[0].toLowerCase());
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return null;
}

/** Trimmed lowercase format token for input_audio (e.g. 'wav', 'mp3'). */
function audioFormat(ext) {
  return ext.replace(/^\./, '');
}

/**
 * Whether a reference is a remote URL (passed through untouched) versus a
 * local path (Base64-encoded).
 */
export function isRemoteUrl(ref) {
  return /^https?:\/\//i.test(String(ref || '').trim());
}

/**
 * Build one multimodal content block from a local file or remote URL.
 *
 * @param {string} ref absolute or cwd-relative file path, or http(s) URL
 * @param {{ maxSizeBytes?: number }} opts
 * @returns {Promise<{ok:true, block:object, media:'image'|'video'|'audio', source:string}
 *           |{ok:false, error:string}>}
 */
export async function buildAttachmentBlock(ref, opts = {}) {
  const src = String(ref || '').trim();
  if (!src) return { ok: false, error: 'empty attachment reference' };
  const media = mediaClassOf(src);
  if (!media) {
    return { ok: false, error: `${src}: unsupported media type (supported: image ${[...IMAGE_EXTS].join(' ')}, video ${[...VIDEO_EXTS].join(' ')}, audio ${[...AUDIO_EXTS].join(' ')})` };
  }

  // Remote URL: pass through; the provider fetches it (BigModel recommends
  // URLs — the URL itself stays the payload).
  if (isRemoteUrl(src)) {
    if (media === 'image') return { ok: true, media, source: src, block: { type: 'image_url', image_url: { url: src } } };
    if (media === 'video') return { ok: true, media, source: src, block: { type: 'video_url', video_url: { url: src } } };
    return { ok: false, error: `${src}: audio URLs are not accepted by the chat-completions API — attach a local audio file instead` };
  }

  // Local file: read + Base64 Data URL.
  let buf;
  try {
    buf = await fs.readFile(src);
  } catch (err) {
    return { ok: false, error: `${src}: ${err.code === 'ENOENT' ? 'file not found' : (err.message || 'unreadable')}` };
  }
  const maxSize = opts.maxSizeBytes ?? MAX_ATTACHMENT_BYTES;
  if (buf.length > maxSize) {
    return { ok: false, error: `${src}: file too large (${(buf.length / 1048576).toFixed(1)} MB > ${(maxSize / 1048576).toFixed(0)} MB limit)` };
  }
  const ext = path.extname(src).toLowerCase();
  const b64 = buf.toString('base64');
  if (media === 'image') {
    const mime = MIME_BY_EXT[ext] || 'image/png';
    return { ok: true, media, source: src, block: { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } } };
  }
  if (media === 'video') {
    const mime = MIME_BY_EXT[ext] || 'video/mp4';
    return { ok: true, media, source: src, block: { type: 'video_url', video_url: { url: `data:${mime};base64,${b64}` } } };
  }
  return {
    ok: true, media, source: src,
    block: { type: 'input_audio', input_audio: { data: b64, format: audioFormat(ext) } },
  };
}

/**
 * Build multimodal content blocks for a list of references, preserving the
 * caller's order. All-or-nothing: any failure fails the whole list with the
 * collected error(s), so a turn is never sent with half its attachments.
 *
 * @param {string[]} refs
 * @returns {Promise<{ok:true, blocks:object[]}|{ok:false, errors:string[]}>}
 */
export async function buildAttachmentBlocks(refs, opts = {}) {
  const blocks = [];
  const errors = [];
  for (const r of refs || []) {
    const out = await buildAttachmentBlock(r, opts);
    if (out.ok) blocks.push(out.block);
    else errors.push(out.error);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, blocks };
}

/**
 * Build the final `content` value for a user message that carries text
 * plus attachment blocks: a non-empty ARRAY of content parts (text first,
 * then media blocks) when any block exists, else the plain text string.
 *
 * @param {string} text user text (may be empty when only attachments given)
 * @param {object[]} blocks attachment content blocks
 * @returns {string|Array<{type:string}>}
 */
export function buildMultimodalContent(text, blocks) {
  const parts = [];
  const t = typeof text === 'string' ? text : '';
  if (t) parts.push({ type: 'text', text: t });
  for (const b of blocks || []) {
    if (b && typeof b === 'object' && b.type) parts.push(b);
  }
  if (parts.length === 0) return t;
  if (parts.every(p => p.type === 'text')) return parts.map(p => p.text).join('');
  return parts;
}

/**
 * Flatten a message content value (string OR content-block array) into a
 * plain string for display / digest / summarizer paths that expect text —
 * media blocks become short placeholders ([image: <n> chars], etc.) so the
 * Base64 payload never floods the UI or the summary prompt.
 *
 * @param {string|Array} content
 * @returns {string}
 */
export function flattenMultimodalContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  const parts = [];
  for (const b of content) {
    if (b == null) continue;
    if (typeof b === 'string') { parts.push(b); continue; }
    if (typeof b !== 'object') { parts.push(String(b)); continue; }
    if (b.type === 'text') { parts.push(typeof b.text === 'string' ? b.text : ''); continue; }
    if (b.type === 'image_url') {
      const url = b.image_url?.url || '';
      parts.push(`[image: ${describeDataRef(url)}]`);
      continue;
    }
    if (b.type === 'video_url') {
      const url = b.video_url?.url || '';
      parts.push(`[video: ${describeDataRef(url)}]`);
      continue;
    }
    if (b.type === 'input_audio') {
      const n = typeof b.input_audio?.data === 'string' ? b.input_audio.data.length : 0;
      parts.push(`[audio: ${b.input_audio?.format || '?'} ${n} chars b64]`);
      continue;
    }
    parts.push(`[${b.type || 'media'}]`);
  }
  return parts.filter(p => p !== '').join('\n');
}

/** Short human description of a media URL / data URL (never the payload). */
function describeDataRef(url) {
  const s = String(url || '');
  const m = s.match(/^data:([^;,]*)[;,]/);
  if (m) return `${m[1] || 'data'} ${s.length} chars`;
  if (s.startsWith('http')) return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/* ------------------------------------------------------------------ */
/* Anthropic dialect conversion                                        */
/* ------------------------------------------------------------------ */

const DATA_URL_RE = /^data:([^;,]+);base64,([\s\S]*)$/;

/**
 * Convert ONE OpenAI-style multimodal block to Anthropic messages-API
 * blocks (returned as an array because unsupported media degrades to a
 * text placeholder alongside nothing else).
 *
 *   text        → text (identical shape)
 *   image_url   → image with a base64 source (data URL) or a url source
 *                 (http(s) — Anthropic fetches it)
 *   video_url / → NO native Anthropic block type exists; degrade to a
 *   input_audio   text placeholder that TELLS the model an attachment was
 *                 omitted, instead of sending an invalid block that would
 *                 400 the whole request.
 */
function blockToAnthropic(b) {
  if (b == null) return [];
  if (typeof b === 'string') return b ? [{ type: 'text', text: b }] : [];
  if (typeof b !== 'object') return [];
  if (b.type === 'text') {
    return [{ type: 'text', text: typeof b.text === 'string' ? b.text : '' }];
  }
  if (b.type === 'image_url') {
    const url = String(b.image_url?.url || '');
    const m = url.match(DATA_URL_RE);
    if (m) return [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }];
    if (/^https?:\/\//i.test(url)) return [{ type: 'image', source: { type: 'url', url } }];
    return [{ type: 'text', text: '[attached image could not be converted: unusable source]' }];
  }
  if (b.type === 'video_url') {
    const url = String(b.video_url?.url || '');
    const mm = url.match(DATA_URL_RE);
    const kind = mm ? mm[1] : 'video';
    return [{ type: 'text', text: `[video attachment (${kind}) omitted: the Anthropic messages API has no video content block]` }];
  }
  if (b.type === 'input_audio') {
    const fmt = b.input_audio?.format || 'audio';
    return [{ type: 'text', text: `[audio attachment (${fmt}) omitted: the Anthropic messages API has no audio content block]` }];
  }
  return [{ type: 'text', text: `[${b.type || 'media'} attachment omitted]` }];
}

/**
 * Convert an OpenAI-style multimodal content-block array into Anthropic
 * messages-API content blocks. Pure; never carries the Base64 payload into
 * text placeholders.
 *
 * @param {Array} blocks
 * @returns {Array<{type:string}>} Anthropic content blocks
 */
export function toAnthropicContentBlocks(blocks) {
  const out = [];
  for (const b of blocks || []) out.push(...blockToAnthropic(b));
  return out;
}

/**
 * Message `content` for the Anthropic wire: strings pass through untouched;
 * content-block arrays are converted (see toAnthropicContentBlocks); an
 * empty conversion degrades to '' so the request never carries an empty
 * content array (Anthropic rejects those).
 */
export function toAnthropicMessageContent(content) {
  if (!Array.isArray(content)) return content;
  const blocks = toAnthropicContentBlocks(content);
  return blocks.length > 0 ? blocks : '';
}
