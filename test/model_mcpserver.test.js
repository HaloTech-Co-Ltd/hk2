/*-------------------------------------------------------------------------
 *
 * /model add-mcpserver regression tests.
 *
 * Adds MCP (Model Context Protocol) server configs to an EXISTING model
 * entry's `mcpServers` array:
 *   /model add-mcpserver <provider>/<model-id> --type=http|stdio
 *                        --name=NAME [--options=JSON]
 *
 * http options: {"url": string (required), "headers": {..} (optional)}.
 * stdio is reserved (recognized but "not implemented yet").
 *
 * Scope guard: the command must NEVER create providers/models and must
 * never touch any other field of the model entry.
 *
 * Run:  node --test test/model_mcpserver.test.js
 *-----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import {
  ensureHome, loadModels, saveModels,
  normalizeMcpServerType, normalizeMcpServerOptions, getModelMcpServers,
} from '../lib/config/home.js';
import { createSession, buildCtx } from '../src/commands/interactive.js';
import { dispatchSlash } from '../src/slash/index.js';

function makeCtx() {
  const session = createSession(null);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  return { ctx, prints };
}

async function seedRegistry() {
  await ensureHome();
  await saveModels({
    providers: {
      bigmodel2: {
        api: 'openai',
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        models: [
          {
            id: 'glm-5.3[1m]',
            name: 'glm-5.3',
            contextWindow: 1048576,
            maxTokens: 262144,
            temperature: 0.2,
            reasoning: true,
            modelType: 'glm-5.3',
          },
        ],
      },
    },
    default: 'bigmodel2/glm-5.3[1m]',
  });
}

/* -------------------- pure helpers -------------------- */

test('normalizeMcpServerType normalizes and rejects unknown types', () => {
  assert.equal(normalizeMcpServerType('http'), 'http');
  assert.equal(normalizeMcpServerType('HTTP'), 'http');
  assert.equal(normalizeMcpServerType(' stdio '), 'stdio');
  assert.equal(normalizeMcpServerType('sse'), null, 'sse not in enum');
  assert.equal(normalizeMcpServerType(''), null);
  assert.equal(normalizeMcpServerType(undefined), null);
});

test('normalizeMcpServerOptions validates http options', () => {
  const ok = normalizeMcpServerOptions('http', '{"url":"https://x/mcp","headers":{"Authorization":"Bearer t"}}');
  assert.deepEqual(ok, { options: { url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } } });

  assert.equal(normalizeMcpServerOptions('http', '{}').error !== undefined, true, 'missing url rejected');
  assert.equal(normalizeMcpServerOptions('http', '{"url":""}').error !== undefined, true, 'empty url rejected');
  assert.equal(normalizeMcpServerOptions('http', 'not json').error !== undefined, true, 'malformed JSON rejected');
  assert.equal(normalizeMcpServerOptions('http', '[1]').error !== undefined, true, 'array rejected');
  const badHeaders = normalizeMcpServerOptions('http', '{"url":"u","headers":{"x":1}}');
  assert.equal(badHeaders.error !== undefined, true, 'non-string header value rejected');
  const unknown = normalizeMcpServerOptions('http', '{"url":"u","cmds":["ls"]}');
  assert.match(unknown.error, /unsupported http option/);
});

test('normalizeMcpServerOptions reports stdio as not implemented', () => {
  const r = normalizeMcpServerOptions('stdio', '{"command":"npx"}');
  assert.match(r.error, /stdio.*not implemented/i);
});

/* -------------------- happy path -------------------- */

test('/model add-mcpserver stores the server on the addressed model (the bigmodel2 example)', async () => {
  await seedRegistry();
  const { ctx, prints } = makeCtx();

  // SECURITY: never put real API keys in code or tests — dummy token only.
  // These tests are offline (parse/persist only); no live MCP connection.
  const FAKE_TOKEN = 'Bearer test-dummy-token';

  await dispatchSlash(
    `/model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=web-reader --options='{` +
    `"url": "https://open.bigmodel.cn/api/mcp/web_reader/mcp", ` +
    `"headers": {"Authorization": "${FAKE_TOKEN}"}}'`,
    ctx,
  );
  assert.ok(prints.some((p) => p.includes('MCP server added: web-reader')), 'confirms the add');

  const { providers } = await loadModels();
  const m = providers.bigmodel2.models[0];
  assert.deepEqual(m.mcpServers, [
    {
      type: 'http',
      name: 'web-reader',
      options: {
        url: 'https://open.bigmodel.cn/api/mcp/web_reader/mcp',
        headers: { Authorization: FAKE_TOKEN },
      },
    },
  ]);

  // Scope guard: nothing else on the entry changed.
  assert.equal(m.id, 'glm-5.3[1m]');
  assert.equal(m.name, 'glm-5.3');
  assert.equal(m.contextWindow, 1048576);
  assert.equal(m.maxTokens, 262144);
  assert.equal(m.temperature, 0.2);
  assert.equal(m.reasoning, true);
  assert.equal(m.modelType, 'glm-5.3');
  assert.equal(m.modelOptions, undefined);
});

test('multi-line quoted --options (newline inside JSON) parse correctly', async () => {
  await seedRegistry();
  const { ctx } = makeCtx();

  const multi =
    `/model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=web-reader --options='{\n` +
    `   "url": "https://open.bigmodel.cn/api/mcp/web_reader/mcp",\n` +
    `   "headers": {\n` +
    `      "Authorization": "Bearer test-dummy-token"\n` +
    `   }\n` +
    `}'`;
  await dispatchSlash(multi, ctx);

  const { providers } = await loadModels();
  assert.equal(providers.bigmodel2.models[0].mcpServers[0].options.url, 'https://open.bigmodel.cn/api/mcp/web_reader/mcp');
});

test('omitting --options is rejected (http requires url in options)', async () => {
  await seedRegistry();
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=bare', ctx);
  assert.ok(prints.some((p) => p.includes('Invalid --options') && p.includes('url')),
    'missing --options → url-required error');
  const { providers } = await loadModels();
  assert.equal(providers.bigmodel2.models[0].mcpServers, undefined, 'nothing persisted');
});

test('re-adding the same --name replaces that server entry; other servers kept', async () => {
  await seedRegistry();
  const { ctx } = makeCtx();
  await dispatchSlash('/model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=a --options=\'{"url":"https://a/mcp"}\'', ctx);
  await dispatchSlash('/model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=b --options=\'{"url":"https://b/mcp"}\'', ctx);
  await dispatchSlash('/model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=a --options=\'{"url":"https://a2/mcp"}\'', ctx);

  const { providers } = await loadModels();
  const servers = providers.bigmodel2.models[0].mcpServers;
  assert.equal(servers.length, 2, 'two servers after replace');
  assert.deepEqual(servers.map((s) => s.name), ['a', 'b']);
  assert.equal(servers[0].options.url, 'https://a2/mcp', 'same-name entry replaced in place');
});

/* -------------------- validation failures -------------------- */

test('missing ref/type/name prints usage and persists nothing', async () => {
  await seedRegistry();
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/model add-mcpserver', ctx);
  assert.ok(prints.some((p) => p.includes('Usage: /model add-mcpserver')), 'usage printed');

  prints.length = 0;
  await dispatchSlash('/model add-mcpserver bigmodel2/glm-5.3[1m] --name=x', ctx);
  assert.ok(prints.some((p) => p.includes('Usage: /model add-mcpserver')), 'missing --type prints usage');

  const { providers } = await loadModels();
  assert.equal(providers.bigmodel2.models[0].mcpServers, undefined, 'nothing persisted');
});

test('unknown --type is rejected; stdio is recognized but not implemented', async () => {
  await seedRegistry();
  const { ctx, prints } = makeCtx();

  prints.length = 0;
  await dispatchSlash('/model add-mcpserver bigmodel2/glm-5.3[1m] --type=sse --name=x', ctx);
  assert.ok(prints.some((p) => p.includes('Unknown MCP server type')), 'unknown type rejected');
  let { providers } = await loadModels();
  assert.equal(providers.bigmodel2.models[0].mcpServers, undefined);

  prints.length = 0;
  await dispatchSlash('/model add-mcpserver bigmodel2/glm-5.3[1m] --type=stdio --name=x', ctx);
  assert.ok(prints.some((p) => p.includes('Invalid --options') && p.includes('stdio')), 'stdio → not-implemented error');
  ({ providers } = await loadModels());
  assert.equal(providers.bigmodel2.models[0].mcpServers, undefined, 'stdio persists nothing');
});

test('invalid --options (missing url / bad JSON / bad headers) persists nothing', async () => {
  await seedRegistry();
  const { ctx, prints } = makeCtx();

  for (const bad of ['{}', 'oops', '{"url":"u","headers":"flat"}']) {
    prints.length = 0;
    await dispatchSlash(`/model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=x --options='${bad}'`, ctx);
    assert.ok(prints.some((p) => p.includes('Invalid --options')), `rejects ${bad}`);
  }
  const { providers } = await loadModels();
  assert.equal(providers.bigmodel2.models[0].mcpServers, undefined, 'nothing persisted');
});

test('unknown model/provider ref is rejected without creating anything', async () => {
  await seedRegistry();
  const { ctx, prints } = makeCtx();

  prints.length = 0;
  await dispatchSlash('/model add-mcpserver nosuch/glm --type=http --name=x --options=\'{"url":"https://x"}\'', ctx);
  assert.ok(prints.some((p) => p.includes('Model not found')), 'unknown provider rejected');
  let { providers } = await loadModels();
  assert.equal(providers.nosuch, undefined, 'no provider created');

  prints.length = 0;
  await dispatchSlash('/model add-mcpserver bigmodel2/nope --type=http --name=x --options=\'{"url":"https://x"}\'', ctx);
  assert.ok(prints.some((p) => p.includes('Model not found')), 'unknown model rejected');
  ({ providers } = await loadModels());
  assert.equal(providers.bigmodel2.models.length, 1, 'no model created');
  assert.equal(providers.bigmodel2.models[0].mcpServers, undefined);
});

/* -------------------- read accessors + display -------------------- */

test('getModelMcpServers is a read-only view', async () => {
  await seedRegistry();
  assert.deepEqual(await getModelMcpServers('bigmodel2/glm-5.3[1m]'), [], 'absent field resolves to empty array');
  assert.equal(await getModelMcpServers('nope/none'), null, 'unknown ref resolves to null');

  const { ctx } = makeCtx();
  await dispatchSlash('/model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=web-reader --options=\'{"url":"https://w/mcp"}\'', ctx);
  const servers = await getModelMcpServers('bigmodel2/glm-5.3[1m]');
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'web-reader');
});

/* -------------------- $APIKEY placeholder -------------------- */

test('$APIKEY placeholder is stored literally and substituted from the provider apiKey at read time', async () => {
  await seedRegistry();
  const { ctx } = makeCtx();

  await dispatchSlash(
    `/model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=web-reader --options='{` +
    `"url": "https://open.bigmodel.cn/api/mcp/web_reader/mcp", ` +
    `"headers": {"Authorization": "Bearer $APIKEY"}}'`,
    ctx,
  );

  // STORED form keeps the literal placeholder — no key copy in models.json.
  const { providers } = await loadModels();
  assert.equal(providers.bigmodel2.models[0].mcpServers[0].options.headers.Authorization, 'Bearer $APIKEY',
    'stored options keep the placeholder');

  // READ view substitutes the provider's apiKey.
  const resolved = await getModelMcpServers('bigmodel2/glm-5.3[1m]');
  assert.equal(resolved[0].options.headers.Authorization, 'Bearer k', 'placeholder → provider apiKey');
  assert.equal(resolved[0].options.url, 'https://open.bigmodel.cn/api/mcp/web_reader/mcp', 'url untouched');

  // resolve:false returns the stored (placeholder) form for display.
  const stored = await getModelMcpServers('bigmodel2/glm-5.3[1m]', { resolve: false });
  assert.equal(stored[0].options.headers.Authorization, 'Bearer $APIKEY', 'resolve:false keeps the placeholder');
});

test('$APIKEY in the url is substituted too; brace form ${APIKEY} works; provider without key degrades to empty string', async () => {
  await seedRegistry();
  const { ctx } = makeCtx();

  await dispatchSlash(
    `/model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=relay --options='{` +
    `"url": "https://relay.example.com/mcp/${'$'}{APIKEY}", ` +
    `"headers": {"Authorization": "Bearer $APIKEY"}}'`,
    ctx,
  );
  const resolved = await getModelMcpServers('bigmodel2/glm-5.3[1m]');
  assert.equal(resolved[0].options.url, 'https://relay.example.com/mcp/k', 'url placeholder substituted');
  assert.equal(resolved[0].options.headers.Authorization, 'Bearer k', 'header placeholder substituted');

  // Provider with empty apiKey: placeholder resolves to '' (explicit degradation).
  const { providers } = await loadModels();
  providers.bigmodel2.apiKey = '';
  await saveModels({ ...providers ? { providers } : {}, default: 'bigmodel2/glm-5.3[1m]' });
  const degraded = await getModelMcpServers('bigmodel2/glm-5.3[1m]');
  assert.equal(degraded[0].options.headers.Authorization, 'Bearer ', 'empty apiKey → empty substitution');
});

test('/model show displays the placeholder, never the resolved key', async () => {
  await seedRegistry();
  const { ctx, prints } = makeCtx();
  await dispatchSlash(
    `/model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=web-reader ` +
    `--options='{"url":"https://w/mcp","headers":{"Authorization":"Bearer $APIKEY"}}'`,
    ctx,
  );

  prints.length = 0;
  await dispatchSlash('/model show', ctx);
  const line = prints.find((p) => p.includes('mcpServer: web-reader'));
  assert.ok(line, 'show renders the server');
  assert.ok(prints.some((p) => p.includes('$APIKEY')), 'shows the placeholder');
  const joined = prints.join('\n');
  assert.ok(!joined.includes('Bearer k'), 'resolved provider key never printed');
});

test('/model list and /model show display attached MCP servers', async () => {
  await seedRegistry();
  const { ctx, prints } = makeCtx();
  await dispatchSlash(
    `/model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=web-reader ` +
    `--options='{"url":"https://open.bigmodel.cn/api/mcp/web_reader/mcp","headers":{"Authorization":"Bearer T"}}'`,
    ctx,
  );

  prints.length = 0;
  await dispatchSlash('/model list', ctx);
  assert.ok(prints.some((p) => p.includes('mcpServer: web-reader (type=http)')), 'list shows the server');

  prints.length = 0;
  await dispatchSlash('/model show', ctx);
  assert.ok(prints.some((p) => p.includes('mcpServer: web-reader (type=http)')), 'show displays the server');
});
