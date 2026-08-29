/*-------------------------------------------------------------------------*/

/**
 * PTY end-to-end test for the REPL live slash-command hint menu — the menu
 * rides readline's private _ttyWrite surface and draws with raw cursor
 * choreography (LF/CUU/CUD/CR/EL), which PassThrough streams can only prove
 * byte-wise, not "what a real terminal would show". This boots the real CLI
 * under a pty, types a slash prefix, and asserts the menu appeared and that
 * Tab acceptance rewrote the input line.
 *
 * Runs via test/_pty_runner.js (util-linux script / macOS expect); skipped
 * when neither backend exists. Run: node --test test/repl_hints_pty.test.js
 */
import './_tty_env.js';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert';
import { ptyAvailable, spawnPty } from './_pty_runner.js';

const HOME = fsSync.mkdtempSync(path.join(os.tmpdir(), 'hk2-hints-pty-'));
process.env.HK2_HOME = HOME;

const { registerProject, setCurrentProject, ensureHome, saveModels } = await import('../lib/config/home.js');
const { addKbForProject } = await import('../lib/index/registry.js');
const { buildIndex } = await import('../lib/index/indexer.js');

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, '..', 'bin', 'hk2');
const hasPty = ptyAvailable();

/** Minimal OpenAI-style SSE server (single short answer, used only to pass the model gate). */
function mockLlmServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }, { finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('pty: live hint menu appears while typing a slash command; Tab accepts; Enter-submitted /help output arrives', { skip: !hasPty }, async () => {
  const src = fsSync.mkdtempSync(path.join(os.tmpdir(), 'hk2-hints-src-'));
  fsSync.writeFileSync(path.join(src, 'one.js'), 'export function alpha() { return 1; }\n');
  await ensureHome();
  const p = await registerProject({ sourcePath: src, name: 'hints-pty' });
  await addKbForProject(p);
  await buildIndex(p.id, { skipSummary: true });
  await setCurrentProject(p.id);

  const mock = await mockLlmServer();
  await saveModels({
    providers: {
      mock: {
        api: 'openai', apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${mock.port}`,
        models: [{ id: 'm1', name: 'm1', contextWindow: 8192, temperature: 0.2 }],
      },
    },
    default: 'mock/m1',
  });

  try {
    const out = await new Promise((resolve, reject) => {
      const { child } = spawnPty(
        `stty rows 30 cols 100 2>/dev/null; exec node ${JSON.stringify(CLI)}`,
        {
          cwd: src,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            HK2_ENABLE_QUERYREWRITE: '0',
            HK2_ENABLE_REQUEST_ASSESS: '0',
            HK2_AUTOIMPORT_CLAUDE: '0',
          },
          // Boot → '/hel' (menu must show /help) → Tab (accept → '/help ')
          // → Enter (dispatch /help) → /quit.
          keys: [
            [2500, '/hel'],
            [3500, '\t'],
            [4500, '\r'],
            [9000, '/quit\r'],
            [12000, '/quit\r'],
          ],
        },
      );
      let buf = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pty timed out; tail: ${buf.slice(-400)}`)); }, 30000);
      child.stdout.on('data', (b) => { buf += b.toString(); });
      child.stderr.on('data', (b) => { buf += b.toString(); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', () => { clearTimeout(timer); resolve(buf); });
    });

    const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    // The menu listed /help while '/hel' was being typed (❯ = selected row).
    assert.ok(/❯\s*\/help/.test(plain), `hint menu offered /help; tail: ${plain.slice(-500)}`);
    // Tab rewrote the input line to the accepted label.
    assert.ok(/\/help\s/.test(plain), 'accepted label echoed with trailing space');
    // Issue-1 regression: the accept repaint must never emit \x1b[0A — xterm
    // reads it as CUU 1 and would draw the input row one line ABOVE the
    // prompt (over the transcript), leaving the real prompt row stale.
    assert.ok(!out.includes('\x1b[0A'), 'no zero-parameter CUU in the accept repaint');
    // Enter dispatched /help — its output block reached the transcript.
    assert.ok(/Available commands|Commands|\/model/.test(plain), '/help output printed');
    assert.ok(plain.includes('Goodbye'), 'clean exit');
  } finally {
    mock.server.close();
    fsSync.rmSync(src, { recursive: true, force: true });
  }
});
