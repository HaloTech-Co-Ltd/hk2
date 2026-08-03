/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频、图表、界面设计、版面框架、有关数据或电子文档等）
 * 均受中华人民共和国法律法规和相应的国际条约保护，易景科技享有上述知识产
 * 权，但相关权利人依照法律规定应享有的权利除外。未免疑义，本条所指的"知识
 * 产权"是指任何及所有基于 Halo 软件产生的：（a）版权、商标、商号、域名、与
 * 商标和商号相关的商誉、设计和专利；与创新、技术诀窍、商业秘密、保密技术、非
 * 技术信息相关的权利；（b）人身权、掩模作品权、署名权和发表权；以及（c）在
 * 本协议生效之前已存在或此后出现在世界任何地方的其他工业产权、专有权、与"知
 * 识产权"相关的权利，以及上述权利的所有续期和延长，无论此类权利是否已在相
 * 关法域内的相关机构注册。
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
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software or
 * in dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in dangerous
 * applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * Document parser — extract plain text + structured sections from common
 * documentation formats.
 *
 * Supported without dependencies (stdlib only):
 *   - Markdown (.md, .markdown)
 *   - Plain text (.txt, .rst, .adoc, README, LICENSE, CHANGELOG)
 *   - JSON (.json) — pretty-printed
 *   - YAML (.yaml, .yml) — naive line-based
 *   - HTML (.html, .htm) — tag-stripped
 *   - SGML (.sgml) - tag-stripped, section-aware
 *
 * Optional (require npm install):
 *   - .pdf  via pdf-parse
 *   - .docx via mammoth
 *
 * Returns a uniform shape:
 *   { kind, title, text, sections: [{title, body, level}] }
 *
 * `kind` is always 'doc'. The indexer routes parsed docs into Eden Space as
 * `doc:<relpath>` entries (searchable via kb_search_knowledge).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import log from '../util/log.js';

const MD_SECTION_RE = /^(#{1,6})\s+(.*)$/;
const HTML_TAG_RE = /<[^>]+>/g;
const HTML_ENTITY = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&nbsp;': ' ', '&copy;': '©', '&reg;': '®',
};

const DOC_EXTS = new Set([
  'md', 'markdown', 'txt', 'rst', 'adoc',
  'json', 'yaml', 'yml',
  'html', 'htm', 'sgml',
  'pdf', 'docx',
  'doc', 'pptx', 'ppt',
]);

const TITLE_FILES = /^(README|LICENSE|CHANGELOG|CONTRIBUTING|AUTHORS|NOTICE|CHANGES|HISTORY)/i;

export function isDocFile(extOrName) {
  if (!extOrName) return false;
  if (extOrName.startsWith('.')) extOrName = extOrName.slice(1);
  const ext = extOrName.toLowerCase();
  if (DOC_EXTS.has(ext)) return true;
  // README, LICENSE etc. are often extension-less
  const base = path.basename(extOrName).toLowerCase();
  return TITLE_FILES.test(base);
}

/**
 * Parse a document file. Returns the uniform shape or null on failure.
 *
 * @param {string} absPath
 * @returns {Promise<object|null>}
 */
export async function parseDocument(absPath) {
  const ext = path.extname(absPath).slice(1).toLowerCase();
  const baseName = path.basename(absPath);

  try {
    if (ext === 'md' || ext === 'markdown') {
      const src = await fs.readFile(absPath, 'utf8');
      return parseMarkdown(src, baseName);
    }
    if (ext === 'json') {
      const src = await fs.readFile(absPath, 'utf8');
      return parseJson(src, baseName);
    }
    if (ext === 'yaml' || ext === 'yml') {
      const src = await fs.readFile(absPath, 'utf8');
      return parseYaml(src, baseName);
    }
    if (ext === 'html' || ext === 'htm') {
      const src = await fs.readFile(absPath, 'utf8');
      return parseHtml(src, baseName);
    }
    if (ext === 'sgml') {
      const src = await fs.readFile(absPath, 'utf8');
      return parseSgml(src, baseName);
    }
    if (ext === 'pdf') {
      return await parsePdf(absPath);
    }
    if (ext === 'docx') {
      return await parseDocx(absPath);
    }
    if (ext === 'doc') {
      return await parseDoc(absPath);
    }
    if (ext === 'pptx') {
      return await parsePptx(absPath);
    }
    if (ext === 'ppt') {
      return await parsePpt(absPath);
    }
    // plain text / rst / adoc / README* / LICENSE* / CHANGELOG*
    const src = await fs.readFile(absPath, 'utf8');
    return parsePlainText(src, baseName);
  } catch (err) {
    log.warn('doc_parser failed', { path: absPath, msg: err.message });
    return null;
  }
}

/**
 * Markdown — split on ATX headings (#, ##, ###), capture H1 as title.
 */
export function parseMarkdown(src, fileName) {
  const lines = src.split('\n');
  const sections = [];
  let title = fileName.replace(/\.(md|markdown)$/i, '');
  let current = { title: '(preamble)', body: [], level: 0 };

  for (const line of lines) {
    const m = MD_SECTION_RE.exec(line);
    if (m) {
      if (current.body.length > 0 || current.title !== '(preamble)') {
        sections.push({ ...current, body: current.body.join('\n').trim() });
      }
      const level = m[1].length;
      const heading = m[2].trim();
      if (level === 1 && sections.length === 0 && current.body.length === 0) {
        title = heading;
      }
      current = { title: heading, body: [], level };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length > 0 || current.title !== '(preamble)') {
    sections.push({ ...current, body: current.body.join('\n').trim() });
  }

  return {
    kind: 'doc',
    title,
    text: src,
    sections,
  };
}

/**
 * JSON — pretty-printed text. Special-case package.json to surface name/version/deps.
 */
export function parseJson(src, fileName) {
  let parsed;
  try { parsed = JSON.parse(src); }
  catch {
    return { kind: 'doc', title: fileName, text: src, sections: [] };
  }

  const sections = [];
  if (fileName === 'package.json' && parsed) {
    const lines = [];
    if (parsed.name) lines.push(`name: ${parsed.name}`);
    if (parsed.version) lines.push(`version: ${parsed.version}`);
    if (parsed.description) lines.push(`description: ${parsed.description}`);
    if (parsed.main) lines.push(`main: ${parsed.main}`);
    if (parsed.scripts) {
      lines.push('scripts:');
      for (const [k, v] of Object.entries(parsed.scripts)) lines.push(`  ${k}: ${v}`);
    }
    if (parsed.dependencies) {
      lines.push('dependencies:');
      for (const [k, v] of Object.entries(parsed.dependencies)) lines.push(`  ${k}: ${v}`);
    }
    if (parsed.devDependencies) {
      lines.push('devDependencies:');
      for (const [k, v] of Object.entries(parsed.devDependencies)) lines.push(`  ${k}: ${v}`);
    }
    sections.push({ title: 'package.json', body: lines.join('\n'), level: 1 });
  }

  return {
    kind: 'doc',
    title: fileName,
    text: JSON.stringify(parsed, null, 2),
    sections,
  };
}

/**
 * YAML — naive: surface top-level keys.
 */
export function parseYaml(src, fileName) {
  const lines = src.split('\n');
  const topKeys = [];
  for (const line of lines) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m && !line.startsWith(' ')) {
      topKeys.push(`${m[1]}: ${m[2] || '(object)'}`);
    }
  }
  return {
    kind: 'doc',
    title: fileName,
    text: src,
    sections: topKeys.length > 0 ? [{ title: 'Top-level keys', body: topKeys.join('\n'), level: 1 }] : [],
  };
}

/**
 * HTML — strip tags, decode entities, split on <h1>/<h2>.
 */
export function parseHtml(src, fileName) {
  let text = src;
  // Capture title from <title>...</title>
  let title = fileName;
  const titleMatch = /<title>([^<]*)<\/title>/i.exec(src);
  if (titleMatch) title = titleMatch[1].trim();

  // Capture headings before stripping tags
  const sections = [];
  const headingRe = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let lastHeading = null;
  let lastLevel = 0;
  let cursor = 0;
  let m;
  while ((m = headingRe.exec(src)) !== null) {
    if (lastHeading !== null) {
      const body = src.slice(cursor, m.index).replace(HTML_TAG_RE, '').replace(/&[a-z]+;/g, e => HTML_ENTITY[e] || e).trim();
      sections.push({ title: lastHeading, body, level: lastLevel });
    }
    lastHeading = m[2].replace(HTML_TAG_RE, '').trim();
    lastLevel = parseInt(m[1], 10);
    cursor = m.index + m[0].length;
  }
  if (lastHeading !== null) {
    const body = src.slice(cursor).replace(HTML_TAG_RE, '').replace(/&[a-z]+;/g, e => HTML_ENTITY[e] || e).trim();
    sections.push({ title: lastHeading, body, level: lastLevel });
  }

  text = src.replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(HTML_TAG_RE, ' ')
            .replace(/&[a-z]+;/g, e => HTML_ENTITY[e] || e)
            .replace(/\s+/g, ' ')
            .trim();

  return { kind: 'doc', title, text, sections };
}

/**
 * SGML - Standard Generalized Markup Language (the parent family of HTML).
 *
 * SGML documents use arbitrary element names, so we can't assume HTML's fixed
 * tag set. We:
 *   1. Capture a title from <title>...</title> if present (else the filename).
 *   2. Split sections on structural elements: HTML-style <h1>-<h3> headings,
 *      plus common DocBook/SGML section elements (chapter, section, sect1-3,
 *      appendix, title). Each element starts a new section whose body is the
 *      text up to the next structural element.
 *   3. Strip remaining markup and decode entities for the flat `text` field.
 *
 * Tolerant of SGML minimization (e.g. unclosed tags) via non-greedy matching.
 */
export function parseSgml(src, fileName) {
  let title = fileName;
  // The document title is the first <title> element (if any). SGML/DocBook
  // also uses <title> inside sections as a heading; we only treat the FIRST
  // one as the document title and strip it from the body.
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  let titleEnd = 0;
  if (titleMatch) {
    title = stripMarkup(titleMatch[1]) || fileName;
    titleEnd = titleMatch.index + titleMatch[0].length;
  }

  // Structural container elements that begin a new section. We capture the
  // element's full content (group 2) as the section body. <title> is NOT a
  // section boundary - it is metadata/heading text that flows into the body.
  const sectionRe = /<(h[1-3]|chapter|section|sect[1-3]|appendix)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const sections = [];
  let m;
  const levelFor = (name) => {
    const n = name.toLowerCase();
    if (/^h[1-3]$/.test(n)) return parseInt(n.slice(1), 10);
    if (n === 'chapter' || n === 'appendix' || n === 'sect1') return 1;
    if (n === 'section' || n === 'sect2') return 2;
    if (n === 'sect3') return 3;
    return 1;
  };
  // Derive a short heading for a section from the first <title>/<h*> child or
  // the element name, then keep the rest as the body.
  const headingOf = (content, elName) => {
    const ht = /<(title|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/i.exec(content);
    if (ht) return stripMarkup(ht[2]).slice(0, 200) || elName;
    return elName;
  };
  const bodyOf = (content) => {
    // Drop leading <title>/<h*> child so it isn't duplicated in the body.
    let c = content.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '');
    c = c.replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h\1>/i, '');
    return stripMarkup(c);
  };

  while ((m = sectionRe.exec(src)) !== null) {
    const content = m[2] || '';
    sections.push({
      title: headingOf(content, m[1]),
      body: bodyOf(content),
      level: levelFor(m[1]),
    });
  }

  // Preamble: text between the document title and the first structural element
  // (or the whole doc if there are no structural elements).
  const firstSectionStart = sections.length > 0 ? src.search(sectionRe) : -1;
  const preambleEnd = firstSectionStart > titleEnd ? firstSectionStart : src.length;
  const preamble = stripMarkup(src.slice(titleEnd, preambleEnd));
  if (preamble.trim()) {
    sections.unshift({ title: title === fileName ? 'preamble' : title, body: preamble, level: 0 });
  }

  // Fallback: no structural elements and no preamble -> single section.
  if (sections.length === 0) {
    const body = stripMarkup(src);
    if (body.trim()) sections.push({ title: title || fileName, body, level: 1 });
  }

  const text = stripMarkup(src).replace(/\s+/g, ' ').trim();
  return { kind: 'doc', title, text, sections };
}

// Strip SGML/HTML markup and decode entities from a string.
function stripMarkup(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')      // comments
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(HTML_TAG_RE, ' ')
    .replace(/&[a-z#0-9]+;/gi, e => HTML_ENTITY[e] || e)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Plain text - break on double newline into a single section. — break on double newline into a single section.
 */
export function parsePlainText(src, fileName) {
  return {
    kind: 'doc',
    title: fileName,
    text: src,
    sections: [{ title: fileName, body: src.trim(), level: 1 }],
  };
}

/**
 * PDF — uses pdf-parse if installed.
 */
async function parsePdf(absPath) {
  let mod;
  try { mod = await import('pdf-parse'); }
  catch {
    log.warn('pdf-parse not installed; skipping PDF', { path: absPath });
    return null;
  }
  const pdf = mod.default || mod;
  const buf = await fs.readFile(absPath);
  const data = await pdf(buf);
  const text = (data && data.text ? data.text : '').trim();
  if (!text) return null;
  const titleMatch = /(.+?)(\n|$)/.exec(text);
  return {
    kind: 'doc',
    title: titleMatch ? titleMatch[1].slice(0, 80) : path.basename(absPath),
    text,
    sections: [{ title: 'content', body: text, level: 1 }],
  };
}

/**
 * DOCX — uses mammoth if installed.
 */
async function parseDocx(absPath) {
  let mod;
  try { mod = await import('mammoth'); }
  catch {
    log.warn('mammoth not installed; skipping DOCX', { path: absPath });
    return null;
  }
  const mammoth = mod.default || mod;
  const result = await mammoth.extractRawText({ path: absPath });
  const text = (result && result.value ? result.value : '').trim();
  if (!text) return null;
  return {
    kind: 'doc',
    title: path.basename(absPath),
    text,
    sections: [{ title: 'content', body: text, level: 1 }],
  };
}

/**
 * Legacy .doc (Word 97-2003, OLE Compound File Binary).
 *
 * .doc is NOT a zip (unlike .docx) - it's a Microsoft Compound File. A full
 * parser is out of scope, so we read the file as a Buffer and extract the
 * printable text runs. This recovers most readable text well enough for KB
 * learning. The method emits contiguous runs of printable characters,
 * decoding the common UTF-16LE (ASCII + 0x00) wide-char runs found in Word.
 */
async function parseDoc(absPath) {
  let buf;
  try { buf = await fs.readFile(absPath); }
  catch (err) {
    log.warn('doc_parser failed to read .doc', { path: absPath, msg: err.message });
    return null;
  }
  if (!buf || buf.length === 0) return null;
  const text = extractPrintableText(buf);
  if (!text || text.trim().length < 2) return null;
  return {
    kind: 'doc',
    title: path.basename(absPath),
    text,
    sections: [{ title: 'content', body: text, level: 1 }],
  };
}

/**
 * PPTX - Office Open XML (a zip). Each slide is an XML part under
 * ppt/slides/slideN.xml; text lives in <a:t>...</a:t> runs.
 * Dependency-free: read the zip with node:zlib and regex the runs.
 */
async function parsePptx(absPath) {
  let buf;
  try { buf = await fs.readFile(absPath); }
  catch (err) {
    log.warn('doc_parser failed to read .pptx', { path: absPath, msg: err.message });
    return null;
  }
  const parts = await unzipEntries(buf).catch(() => []);
  const slideRe = /^ppt\/slides\/slide\d+\.xml$/i;
  const slides = parts.filter(p => slideRe.test(p.name))
    .sort((a, b) => slideIndex(a.name) - slideIndex(b.name));
  if (slides.length === 0) return null;
  const sections = [];
  const allText = [];
  for (let i = 0; i < slides.length; i++) {
    const xml = slides[i].data.toString('utf8');
    const runs = extractXmlTextRuns(xml, 'a:t');
    const body = runs.join(' ');
    allText.push(body);
    sections.push({ title: `Slide ${i + 1}`, body, level: 1 });
  }
  const text = allText.join('\n\n');
  if (!text.trim()) return null;
  return {
    kind: 'doc',
    title: path.basename(absPath),
    text,
    sections,
  };
}

/**
 * Legacy .ppt (PowerPoint 97-2003, OLE Compound File Binary).
 * Same best-effort binary text extraction as .doc.
 */
async function parsePpt(absPath) {
  let buf;
  try { buf = await fs.readFile(absPath); }
  catch (err) {
    log.warn('doc_parser failed to read .ppt', { path: absPath, msg: err.message });
    return null;
  }
  if (!buf || buf.length === 0) return null;
  const text = extractPrintableText(buf);
  if (!text || text.trim().length < 2) return null;
  return {
    kind: 'doc',
    title: path.basename(absPath),
    text,
    sections: [{ title: 'content', body: text, level: 1 }],
  };
}

// ---- helpers for Office Open XML / binary extraction ----

function slideIndex(name) {
  const m = /slide(\d+)\.xml$/i.exec(name);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Very small ZIP reader: returns [{name, data}] for each stored/deflated entry.
 * Sufficient for Office Open XML (.docx/.pptx) where the central directory
 * lists every part. No streaming; loads whole file (docs are small).
 */
async function unzipEntries(buf) {
  const zlib = await import('node:zlib');
  if (buf.length < 22) return [];
  // Locate End Of Central Directory record (EOCD).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65557; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i; break;
    }
  }
  if (eocd < 0) return [];
  const cdCount = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < cdCount; i++) {
    if (cdOff + 46 > buf.length) break;
    if (buf.readUInt32LE(cdOff) !== 0x02014b50) break;
    const compMethod = buf.readUInt16LE(cdOff + 10);
    const compSize = buf.readUInt32LE(cdOff + 20);
    const nameLen = buf.readUInt16LE(cdOff + 28);
    const extraLen = buf.readUInt16LE(cdOff + 30);
    const commLen = buf.readUInt16LE(cdOff + 32);
    const lfhOff = buf.readUInt32LE(cdOff + 42);
    const name = buf.slice(cdOff + 46, cdOff + 46 + nameLen).toString('utf8');
    // Local file header has its own name/extra lengths.
    let dataOff = lfhOff + 30;
    if (lfhOff + 30 <= buf.length && buf.readUInt32LE(lfhOff) === 0x04034b50) {
      const lfhNameLen = buf.readUInt16LE(lfhOff + 26);
      const lfhExtraLen = buf.readUInt16LE(lfhOff + 28);
      dataOff = lfhOff + 30 + lfhNameLen + lfhExtraLen;
    }
    let data;
    if (compMethod === 0) {
      data = buf.slice(dataOff, dataOff + compSize);
    } else if (compMethod === 8) {
      data = zlib.inflateRawSync(buf.slice(dataOff, dataOff + compSize));
    } else {
      data = Buffer.alloc(0);
    }
    out.push({ name, data });
    cdOff += 46 + nameLen + extraLen + commLen;
  }
  return out;
}

/**
 * Pull text out of XML <tag>...</tag> runs. Returns an array of trimmed
 * strings (one per element), preserving slide/paragraph granularity.
 */
function extractXmlTextRuns(xml, tag) {
  const runs = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = decodeXmlEntities(m[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) runs.push(t);
  }
  return runs;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Best-effort text extraction from a binary Office (OLE) file. Emits
 * contiguous runs of printable characters, treating the common UTF-16LE
 * (ASCII + 0x00) wide-char runs as single characters. Returns plain text
 * with paragraphs separated by newlines.
 */
function extractPrintableText(buf) {
  const paragraphs = [];
  let cur = '';
  let lastWasNewline = false;
  const flush = () => {
    const t = cur.trim();
    if (t) paragraphs.push(t);
    cur = '';
  };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    const isPrint = (b >= 0x20 && b < 0x7f) || b >= 0xa0;
    if (isPrint) {
      cur += String.fromCharCode(b);
      lastWasNewline = false;
      // Detect UTF-16LE: an ASCII char followed by a 0x00 byte often indicates
      // a wide-char run in .doc/.ppt. Emit the ASCII char and skip the null.
      if (b < 0x80 && i + 1 < buf.length && buf[i + 1] === 0x00) {
        i += 1;
      }
    } else if (b === 0x0a || b === 0x0d) {
      if (!lastWasNewline) { flush(); lastWasNewline = true; }
    } else if (cur.length > 0 && (b === 0x09 || b === 0x00)) {
      // tab or embedded null inside a run -> keep as space
      if (!cur.endsWith(' ')) cur += ' ';
    } else if (cur.length >= 4) {
      // A control byte breaks the run; start a new paragraph at the next print.
      flush();
    }
  }
  flush();
  return paragraphs.filter(p => p.length >= 2).join('\n');
}

/**
 * Compact a parsed doc into a single string suitable for Eden entry `intro`.
 * Caps at ~8000 chars.
 */
export function compactDoc(parsed, maxChars = 8000) {
  if (!parsed) return '';
  const parts = [];
  if (parsed.sections && parsed.sections.length > 0) {
    for (const s of parsed.sections) {
      parts.push(`## ${s.title}\n${(s.body || '').trim()}`);
      if (parts.join('\n\n').length > maxChars) break;
    }
  } else {
    parts.push(parsed.text || '');
  }
  return parts.join('\n\n').slice(0, maxChars);
}
