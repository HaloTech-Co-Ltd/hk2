/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频，图表，界面设计、版面框架，有关数据或电子文档等）
 * 均受中华人民共和国法律法规和相应的国际条约保护，易景科技享有上述知识产
 * 权，但相关权利人依照法律规定应享有的权利除外。未免疑义，本条所指的"知识
 * 产权"是指任何及所有基于 Halo 软件产生的：（a）版权、商标、商号、域名、与
 * 商标和商号相关的商誉、设计和专利；与创新，技术诀窍、商业秘密、保密技术、非
 * 技术信息相关的权利；（b）人身权、掩模作品权、署名权和发表权；以及（c）在
 * 本协议生效之前已存在或此后出现在世界任何地方的其他工业产权、专有权、与"知
 * 识产权"相关的权利，以及上述权利的所有续期和延长，无论此类权利是否已在相
 * 关法域内的相关机构注册。
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. As expressly permitted in
 * your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software in
 * dangerous applications, then you shall be responsible for taking all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in
 * dangerous applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * Ergonomic first-run bootstrap: when hk2 has NO default model configured,
 * import one from Claude Code's ~/.claude/settings.json (the `env` block:
 * ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY, plus the
 * ANTHROPIC_DEFAULT_*_MODEL hints). A Claude Code user then gets a working
 * `hk2 --tui` on first launch with zero setup.
 *
 * Semantics:
 *   - Fill-only: never touches models.json when a default already exists.
 *   - Idempotent: a second boot with no Claude config is a no-op.
 *   - Kill switch: HK2_AUTOIMPORT_CLAUDE=0 disables the import entirely.
 *   - The anthropic adapter sends BOTH x-api-key and Authorization: Bearer,
 *     so ANTHROPIC_AUTH_TOKEN gateways (e.g. bigmodel's /api/anthropic)
 *     authenticate unchanged.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadModels, saveModels } from '../lib/config/home.js';

const ENV_OFF = /^(0|no|false|off)$/i;
const PROVIDER = 'claude';

export function claudeSettingsPath(homeDir) {
  return path.join(homeDir || os.homedir(), '.claude', 'settings.json');
}

/**
 * @returns {Promise<{imported:boolean, reason?:string, ref?:string, models?:string[]}>}
 *   imported:true — a provider was registered and set as the default.
 */
/**
 * Context window per known model id. Claude Code's settings.json carries NO
 * context-size information, so an import has to assume — and a wrong
 * assumption skews two user-visible things: the footer's context % and the
 * auto-compact threshold (both key off contextWindow). Ids we recognize get
 * their real window; unknown ids keep the conservative 200k default
 * (correct for the claude-* family the endpoint usually fronts). Fix a
 * mis-guessed entry with: /model set claude/<id> --context-window=<N>.
 */
const DEFAULT_CONTEXT_WINDOW = 200000;
// EXACT ids only (review round 5): a broad prefix match (/glm-5/) would
// also capture future/smaller variants (a 128k glm-5.x-flash would be
// inflated 8x, delaying auto-compact until the provider hard-fails).
// Unlisted ids keep the conservative default; fix any entry with
// /model set claude/<id> --context-window=<N>.
const KNOWN_CONTEXT_WINDOWS = new Map([
  // BigModel GLM-5.3: 1M context (user-confirmed on the anthropic-compatible
  // endpoint).
  ['glm-5.3', 1000000],
]);

export function importedContextWindow(id) {
  return KNOWN_CONTEXT_WINDOWS.get(id) ?? DEFAULT_CONTEXT_WINDOW;
}

export async function autoImportClaudeModel({ homeDir } = {}) {
  if (ENV_OFF.test(String(process.env.HK2_AUTOIMPORT_CLAUDE ?? ''))) {
    return { imported: false, reason: 'disabled' };
  }

  // Read models.json ONCE (a second read below would risk a lost update
  // against a concurrent import).
  const modelsData = await loadModels();
  if (modelsData.default) {
    return { imported: false, reason: 'already-configured' };
  }
  // Never clobber a user's existing 'claude' provider — a manual
  // /model add claude ... must survive a default-less first run.
  if (modelsData.providers[PROVIDER]) {
    return { imported: false, reason: 'provider-exists' };
  }

  let settings;
  try {
    settings = JSON.parse(await fs.readFile(claudeSettingsPath(homeDir), 'utf8'));
  } catch {
    return { imported: false, reason: 'no-claude-settings' };
  }
  const env = settings && typeof settings.env === 'object' ? settings.env : {};
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL.trim() : '';
  const apiKey = (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.trim())
    || (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim())
    || '';
  if (!baseUrl || !apiKey) {
    return { imported: false, reason: 'no-anthropic-endpoint' };
  }

  // Model list from the DEFAULT_*_MODEL hints (Claude Code's model-routing
  // overrides). Dedupe, keep the sonnet/opus pick first — the "main" model.
  const hints = [
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env.ANTHROPIC_MODEL,
  ].filter(v => typeof v === 'string' && v.trim());
  if (hints.length === 0) hints.push('claude-sonnet-4-6'); // seed fallback only
  const seen = new Set();
  const ids = [];
  for (const h of hints) {
    const id = h.trim();
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }

  modelsData.providers[PROVIDER] = {
    api: 'anthropic',
    apiKey,
    baseUrl,
    importedFrom: 'claude-settings',
    importedAt: new Date().toISOString(),
    models: ids.map(id => ({
      id,
      name: id,
      contextWindow: importedContextWindow(id),
      maxTokens: 16384,
      reasoning: true,
      temperature: 0.2,
    })),
  };
  modelsData.default = `${PROVIDER}/${ids[0]}`;
  await saveModels(modelsData);
  return { imported: true, ref: modelsData.default, models: ids };
}
