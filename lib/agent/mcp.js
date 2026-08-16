/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * (License header identical to the rest of the codebase — see
 *  src/slash/model.js lines 1-39.)
 *-----------------------------------------------------------------------*/

/**
 * MCP (Model Context Protocol) client runtime — Streamable HTTP transport.
 *
 * Server configs come from /model add-mcpserver (stored per-model in
 * ~/.hk2/models.json, mcpServers array). This module turns those configs
 * into agent-callable tools:
 *
 *   - McpHttpClient: one instance per server. Handles the JSON-RPC session
 *     handshake (initialize → notifications/initialized), keeps the
 *     mcp-session-id, parses both SSE (text/event-stream) and plain JSON
 *     responses, and transparently re-initializes once when a session has
 *     expired (HTTP 404 on a call).
 *   - McpToolRegistry: caches clients + tools/list per model ref so an
 *     agent turn does not redo the handshake. Re-fetches when the model
 *     config changes (by ref string).
 *   - buildMcpTools(): async factory returning hk2 tool objects shaped like
 *     the built-ins in lib/agent/tools.js ({ name, description, parameters,
 *     execute }) but named `mcp__<server>__<tool>` to avoid collisions.
 *
 * Failure policy: attaching is BEST-EFFORT. A server that cannot be reached
 * yields a warning surface (not an exception) — the agent session stays
 * usable with its built-in tools. Tool execution errors are returned as
 * { ok:false }-style results for the loop to feed back to the LLM.
 *
 * SECURITY: options are resolved (the $APIKEY placeholder substituted) by
 * getModelMcpServers at READ time; the resolved values live only in the
 * in-memory client. Nothing resolved is ever logged or printed.
 */
import { getModelMcpServers } from '../config/home.js';

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESULT_CHARS = 24000;

/** JSON-RPC id source (per-process counter). */
let rpcSeq = 0;

/** Sanitize a server name into a tool-name-safe fragment. */
function toolNamePart(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+$/g, '').replace(/^_+/g, '') || 'x';
}

/** Tool name shown to the LLM: mcp__<server>__<tool>. */
export function mcpToolName(serverName, toolName) {
  return `mcp__${toolNamePart(serverName)}__${toolNamePart(toolName)}`;
}

/**
 * Extract the JSON-RPC response payload from a fetch Response that may be
 * SSE (text/event-stream) or plain JSON. Returns the raw text of the first
 * message carrying a `data:` line (SSE) or the whole body (JSON).
 */
async function readRpcPayload(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  if (ct.includes('text/event-stream')) {
    const dataLines = text.split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    // Skip SSE notifications / pings: return the first parseable JSON-RPC
    // message with an id (responses). Fall back to the first data line.
    for (const d of dataLines) {
      try {
        const j = JSON.parse(d);
        if (j && (j.id !== undefined || j.result !== undefined || j.error)) return d;
      } catch { /* not JSON — skip */ }
    }
    return dataLines[0] || '';
  }
  return text;
}

/** One MCP server connection over Streamable HTTP. */
export class McpHttpClient {
  /**
   * @param {string} url server endpoint
   * @param {object} [opts]
   * @param {Record<string,string>} [opts.headers] auth headers etc. (resolved)
   * @param {number} [opts.timeoutMs] per-request timeout
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.headers = { ...(opts.headers || {}) };
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.sessionId = null;
    this.serverInfo = null;
    this.protocolVersion = DEFAULT_PROTOCOL_VERSION;
    this.initialized = false;
  }

  /** POST one JSON-RPC message; returns { status, payload }. */
  async rpc(body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const payload = await readRpcPayload(res);
      return { status: res.status, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  /** initialize + notifications/initialized handshake. Idempotent-ish: re-runs reset the session. */
  async initialize() {
    this.sessionId = null;
    const { status, payload } = await this.rpc({
      jsonrpc: '2.0',
      id: ++rpcSeq,
      method: 'initialize',
      params: {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'hk2', version: '0.1.0' },
      },
    });
    if (status !== 200) {
      throw new Error(`initialize failed: HTTP ${status} ${String(payload).slice(0, 160)}`);
    }
    const msg = this._parse(payload, 'initialize');
    this.serverInfo = msg.result?.serverInfo || null;
    this.protocolVersion = msg.result?.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    // initialized notification (no response expected; 202 accepted is typical)
    await this.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
    this.initialized = true;
    return this.serverInfo;
  }

  /** tools/list → [{ name, description, inputSchema }] */
  async listTools() {
    const msg = await this.call('tools/list', {});
    return msg.result?.tools || [];
  }

  /**
   * tools/call → { content: [...], isError? } shaped for the agent loop.
   * Re-initializes once on 404 (expired session), then retries.
   */
  async callTool(toolName, args) {
    try {
      return await this._callToolInner(toolName, args);
    } catch (err) {
      if (err && err.httpStatus === 404 && this.initialized) {
        this.initialized = false;
        await this.initialize();
        return await this._callToolInner(toolName, args);
      }
      throw err;
    }

  }

  async _callToolInner(toolName, args) {
    const msg = await this.call('tools/call', { name: toolName, arguments: args || {} });
    const r = msg.result;
    if (!r) throw new Error('tools/call returned no result');
    if (r.isError) {
      const txt = (r.content || []).map((c) => c.text || '').join('\n');
      throw new Error(txt || 'MCP tool reported an error');
    }
    // Flatten content blocks to text; images/resources are summarized.
    const parts = [];
    for (const c of r.content || []) {
      if (typeof c.text === 'string') parts.push(c.text);
      else if (c.type === 'image') parts.push(`[image: ${c.mimeType || 'unknown'}]`);
      else if (c.type === 'resource') parts.push(`[resource: ${c.resource?.uri || '?'}]`);
      else parts.push(JSON.stringify(c));
    }
    let text = parts.join('\n');
    if (text.length > MAX_RESULT_CHARS) {
      text = `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated ${text.length - MAX_RESULT_CHARS} chars]`;
    }
    return text;
  }

  /** Generic request → parsed JSON-RPC message; throws with httpStatus on non-200. */
  async call(method, params) {
    const { status, payload } = await this.rpc({
      jsonrpc: '2.0', id: ++rpcSeq, method, params,
    });
    if (status === 404) {
      const err = new Error(`HTTP 404 (session may have expired): ${method}`);
      err.httpStatus = 404;
      throw err;
    }
    if (status !== 200) {
      const err = new Error(`HTTP ${status} on ${method}: ${String(payload).slice(0, 160)}`);
      err.httpStatus = status;
      throw err;
    }
    return this._parse(payload, method);
  }

  _parse(payload, method) {
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      throw new Error(`non-JSON response to ${method}: ${String(payload).slice(0, 160)}`);
    }
    if (msg.error) {
      throw new Error(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
    }
    return msg;
  }
}

/**
 * Per-process cache of (model ref → { clients, tools, warns }) so repeated
 * agent turns do not redo the MCP handshake. Invalidate by ref when the
 * model config changes (noteReloadModels / setModel).
 */
const registryCache = new Map();

/** Drop the cached MCP toolset for a model ref (call on config reload). */
export function invalidateMcpTools(ref) {
  if (ref) registryCache.delete(ref);
}

export function invalidateAllMcpTools() {
  registryCache.clear();
}

/**
 * Build hk2-shaped tool objects for every MCP server attached to the model.
 *
 * @param {string} modelRef `provider/model-id` of the ACTIVE model
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.onWarn] warning sink (default console.error)
 * @returns {Promise<{tools: object[], warns: string[]}>}
 */
export async function buildMcpTools(modelRef, opts = {}) {
  const onWarn = opts.onWarn || (() => {});
  const warns = [];
  if (!modelRef) return { tools: [], warns };
  let servers;
  try {
    servers = await getModelMcpServers(modelRef); // $APIKEY resolved here
  } catch (err) {
    const w = `MCP servers unavailable: ${err.message}`;
    warns.push(w); onWarn(w);
    return { tools: [], warns };
  }
  if (!Array.isArray(servers) || servers.length === 0) return { tools: [], warns };

  const tools = [];
  for (const s of servers) {
    if (s.type !== 'http' || !s.options?.url) continue; // stdio etc. not implemented
    let client;
    let serverTools;
    try {
      client = new McpHttpClient(s.options.url, { headers: s.options.headers });
      await client.initialize();
      serverTools = await client.listTools();
    } catch (err) {
      const w = `MCP server "${s.name}" unavailable (${err.message}); session continues without it`;
      warns.push(w); onWarn(w);
      continue;
    }
    for (const t of serverTools) {
      tools.push({
        name: mcpToolName(s.name, t.name),
        description: `[MCP:${s.name}] ${t.description || t.name}`,
        parameters: (t.inputSchema && typeof t.inputSchema === 'object')
          ? t.inputSchema
          : { type: 'object', properties: {} },
        execute: async (args) => {
          try {
            return await client.callTool(t.name, args);
          } catch (err) {
            return { error: `mcp tool ${t.name} failed: ${err.message}` };
          }
        },
      });
    }
  }
  return { tools, warns };
}

/**
 * Cached variant used by the agent turn: returns the cached toolset for the
 * ref when present, otherwise attaches (handshake) and caches. Config
 * reloads call invalidateMcpTools(ref) / invalidateAllMcpTools().
 *
 * @returns {Promise<{tools: object[], warns: string[]}>} same shape as buildMcpTools
 */
export async function getMcpTools(modelRef, opts = {}) {
  if (!modelRef) return { tools: [], warns: [] };
  const hit = registryCache.get(modelRef);
  if (hit) return hit;
  const built = await buildMcpTools(modelRef, opts);
  registryCache.set(modelRef, built);
  return built;
}
