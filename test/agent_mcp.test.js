/*-------------------------------------------------------------------------
 *
 * MCP agent-tool integration tests (lib/agent/mcp.js).
 *
 * A local fake MCP server (node:http) implements the Streamable HTTP
 * transport: initialize / notifications/initialized / tools/list /
 * tools/call, SSE responses, session ids, and 404 session-expiry. NO real
 * API key or network access is involved (security rule: keys never appear
 * in code or tests).
 *
 * Run:  node --test test/agent_mcp.test.js
 *-----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { ensureHome, saveModels } from '../lib/config/home.js';
import {
  McpHttpClient, mcpToolName, buildMcpTools, getMcpTools,
  invalidateMcpTools, invalidateAllMcpTools,
} from '../lib/agent/mcp.js';

/* ------------------------- fake MCP server ------------------------- */

/**
 * Minimal MCP-over-HTTP server. Behaviors:
 *   - assigns a session id on initialize; requires it afterwards
 *   - answers SSE (text/event-stream) for every JSON-RPC response
 *   - tools: echo (echoes args), fail (returns isError)
 *   - expireAfter: number of successful calls before the session 404s
 */
function makeFakeServer({ expireAfter = Infinity, authHeader = null } = {}) {
  const state = { sessions: new Set(), calls: 0, perSession: new Map(), seq: 0, requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.requests.push({ url: req.url, headers: req.headers, body });
      if (authHeader !== null && (req.headers.authorization || '') !== authHeader) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'bad auth' } }));
        return;
      }
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
      const sid = req.headers['mcp-session-id'] || null;

      const sse = (obj) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify(obj)}\n\n`);
      };

      if (msg.method === 'initialize') {
        state.seq += 1;
        const newSid = `sess-${state.seq}`;
        state.sessions.add(newSid);
        state.perSession.set(newSid, 0);
        res.setHeader('mcp-session-id', newSid);
        sse({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fake-mcp', version: '0.0.1' } } });
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202); res.end();
        return;
      }
      // requests after initialize require a live session
      if (!sid || !state.sessions.has(sid)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      state.calls += 1;
      const perSid = (state.perSession.get(sid) || 0) + 1;
      state.perSession.set(sid, perSid);
      if (perSid > expireAfter) {
        state.sessions.delete(sid);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'session expired' }));
        return;
      }
      if (msg.method === 'tools/list') {
        sse({
          jsonrpc: '2.0', id: msg.id,
          result: {
            tools: [
              { name: 'echo', description: 'Echo the arguments', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
              { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
            ],
          },
        });
        return;
      }
      if (msg.method === 'tools/call') {
        const name = msg.params?.name;
        if (name === 'echo') sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo: ${msg.params.arguments?.text ?? ''}` }] } });
        else if (name === 'fail') sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } });
        else sse({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
        return;
      }
      sse({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
    });
  });
  return { server, state };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function seedModelWithServer(mcpServers) {
  await ensureHome();
  await saveModels({
    providers: {
      p: { api: 'openai', baseUrl: '', apiKey: 'test-key', models: [{ id: 'm', name: 'm', contextWindow: 65536, mcpServers }] },
    },
    default: 'p/m',
  });
}

/* ------------------------- unit: naming ------------------------- */

test('mcpToolName sanitizes server and tool names', () => {
  assert.equal(mcpToolName('web-reader', 'webReader'), 'mcp__web-reader__webReader');
  assert.equal(mcpToolName('weird name!', 'tool.name'), 'mcp__weird_name__tool_name');
});

/* ------------------------- integration ------------------------- */

test('McpHttpClient: initialize → tools/list → tools/call over SSE with session id', async () => {
  const { server, state } = makeFakeServer();
  const port = await listen(server);
  try {
    const c = new McpHttpClient(`http://127.0.0.1:${port}/mcp`);
    const info = await c.initialize();
    assert.equal(info.name, 'fake-mcp');
    assert.ok(c.sessionId, 'session id captured from response header');
    const tools = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['echo', 'fail']);
    const out = await c.callTool('echo', { text: 'hi' });
    assert.equal(out, 'echo: hi');
    assert.equal(state.requests.filter((r) => r.url === '/mcp').length >= 4, true, 'all requests hit the endpoint');
  } finally {
    await close(server);
  }
});

test('McpHttpClient: tools/call error surfaces as thrown Error with the tool text', async () => {
  const { server } = makeFakeServer();
  const port = await listen(server);
  try {
    const c = new McpHttpClient(`http://127.0.0.1:${port}/mcp`);
    await c.initialize();
    await assert.rejects(() => c.callTool('fail', {}), /boom/);
  } finally {
    await close(server);
  }
});

test('McpHttpClient: recovers from a 404 session expiry by re-initializing once', async () => {
  const { server } = makeFakeServer({ expireAfter: 2 }); // tools/list + first call ok, then expiry
  const port = await listen(server);
  try {
    const c = new McpHttpClient(`http://127.0.0.1:${port}/mcp`);
    await c.initialize();
    await c.listTools();
    await c.callTool('echo', { text: 'a' });
    // Session now expires on the server side; the next call transparently
    // re-initializes and retries.
    const out = await c.callTool('echo', { text: 'b' });
    assert.equal(out, 'echo: b');
  } finally {
    await close(server);
  }
});

test('buildMcpTools: full attach from a model ref — $APIKEY resolved, tools registered, callable', async () => {
  const { server, state } = makeFakeServer({ authHeader: 'Bearer test-key' });
  const port = await listen(server);
  try {
    // Stored config uses the $APIKEY placeholder; the fake server only
    // accepts the provider key 'test-key' — proves runtime resolution.
    await seedModelWithServer([
      { type: 'http', name: 'web-reader', options: { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer $APIKEY' } } },
    ]);
    const { tools, warns } = await buildMcpTools('p/m');
    assert.equal(warns.length, 0);
    assert.deepEqual(tools.map((t) => t.name), ['mcp__web-reader__echo', 'mcp__web-reader__fail']);
    assert.match(tools[0].description, /^\[MCP:web-reader\]/);
    assert.equal(tools[0].parameters.required[0], 'text', 'inputSchema passed through');
    const out = await tools[0].execute({ text: 'live' });
    assert.equal(out, 'echo: live');
    // The resolved Authorization header (with the real provider key shape)
    // reached the server; the STORED placeholder never did.
    assert.equal(state.requests[0].headers.authorization, 'Bearer test-key');
  } finally {
    await close(server);
  }
});

test('buildMcpTools: unreachable server yields a warn, not a crash; other servers still attach', async () => {
  const good = makeFakeServer();
  const port = await listen(good.server);
  try {
    await seedModelWithServer([
      { type: 'http', name: 'down', options: { url: 'http://127.0.0.1:1/mcp' } }, // nothing listens
      { type: 'http', name: 'up', options: { url: `http://127.0.0.1:${port}/mcp` } },
    ]);
    const { tools, warns } = await buildMcpTools('p/m');
    assert.equal(tools.length, 2, 'good server tools attached');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /"down" unavailable/);
  } finally {
    await close(good.server);
  }
});

test('buildMcpTools: non-http servers and models without servers are no-ops', async () => {
  await seedModelWithServer([]);
  assert.deepEqual(await buildMcpTools('p/m'), { tools: [], warns: [] });
  await seedModelWithServer([{ type: 'stdio', name: 's', options: {} }]);
  assert.deepEqual(await buildMcpTools('p/m'), { tools: [], warns: [] }, 'stdio skipped silently');
  assert.deepEqual(await buildMcpTools('nope/none'), { tools: [], warns: [] }, 'unknown ref → no tools');
  assert.deepEqual(await buildMcpTools(null), { tools: [], warns: [] });
});

test('getMcpTools caches per ref; invalidateMcpTools / invalidateAllMcpTools drop it', async () => {
  const { server } = makeFakeServer();
  const port = await listen(server);
  try {
    await seedModelWithServer([
      { type: 'http', name: 'srv', options: { url: `http://127.0.0.1:${port}/mcp` } },
    ]);
    const a = await getMcpTools('p/m');
    const b = await getMcpTools('p/m');
    assert.equal(a, b, 'same object identity — cached');
    invalidateMcpTools('p/m');
    const c = await getMcpTools('p/m');
    assert.notEqual(a, c, 'cache dropped after invalidation');
    const d = await getMcpTools('p/m');
    assert.equal(c, d, 'cached again');
    invalidateAllMcpTools();
    const e = await getMcpTools('p/m');
    assert.notEqual(c, e, 'full invalidation drops it too');
  } finally {
    await close(server);
  }
});

test('attached tool execute returns { error } on transport failure instead of throwing', async () => {
  const { server } = makeFakeServer();
  const port = await listen(server);
  await seedModelWithServer([
    { type: 'http', name: 'srv', options: { url: `http://127.0.0.1:${port}/mcp` } },
  ]);
  const { tools } = await buildMcpTools('p/m');
  await close(server); // kill the server underneath the cached client
  const out = await tools[0].execute({ text: 'x' });
  assert.ok(out && typeof out.error === 'string', 'error result, not a throw');
  assert.match(out.error, /failed/);
});
