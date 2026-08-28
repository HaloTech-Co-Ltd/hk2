/*-------------------------------------------------------------------------
 *
 * PTY integration test for the REPL mid-task instruction input box — the
 * one path that rides Node readline's PRIVATE surface (rl._writeToOutput
 * redirect, rl.line/rl.cursor manipulation). Byte-level unit tests cannot
 * see it: the whole point is what a real terminal shows while an agent
 * turn streams. A local mock SSE server stalls mid-turn so the box is on
 * screen when the second line is typed.
 *
 * Sequence: boot the line REPL under a pty → submit a message → while the
 * mock model stalls, the reserved `» add instruction ▏` row must appear →
 * type a second line → the `queued #1` receipt must print (and the box row
 * clear) → the stream finishes → /quit exits cleanly.
 *
 * Runs via test/_pty_runner.js: util-linux `script -qec` on Linux, system
 * `expect` on macOS (BSD script has no -c and rejects pipe stdin).
 * Skipped when neither backend is available. Run: node --test test/repl_midtask_pty.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';

// HK2_HOME must be pinned BEFORE lib/config/home.js is imported (it freezes
// the path at module load) — this file manages its own isolation instead of
// using _learn_setup, which other suites mutate.
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert';
import { ptyAvailable, spawnPty } from './_pty_runner.js';

const HOME = fsSync.mkdtempSync(path.join(os.tmpdir(), 'hk2-midtask-pty-'));
process.env.HK2_HOME = HOME;

const { registerProject, setCurrentProject, ensureHome, saveModels } = await import('../lib/config/home.js');
const { addKbForProject } = await import('../lib/index/registry.js');
const { buildIndex } = await import('../lib/index/indexer.js');

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, '..', 'bin', 'hk2');

const hasScript = ptyAvailable(); // util-linux script OR macOS expect

/** Mock OpenAI-style SSE server whose first response STALLS 2.5s. */
function mockLlmServer() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const t1 = setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'working on it' } }] })}\n\n`);
    }, 2500);
    const t2 = setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }, { finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }, 3200);
    req.on('close', () => { clearTimeout(t1); clearTimeout(t2); try { res.end(); } catch { /* gone */ } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls: () => calls })));
}

test('pty: mid-task instruction box appears during a turn; queued receipt prints; private readline path survives', { skip: !hasScript }, async () => {
  // A tiny registered project with a built KB (the chat gate requires it).
  const src = fsSync.mkdtempSync(path.join(os.tmpdir(), 'hk2-midtask-src-'));
  fsSync.writeFileSync(path.join(src, 'one.js'), 'export function alpha() { return 1; }\n');
  await ensureHome();
  const p = await registerProject({ sourcePath: src, name: 'midtask-pty' });
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
          // Boot → first message → (turn stalls on the mock) second line → quit.
          // Generous waits: under `node --test` the machine is busier than a bare
          // shell, and the whole point is what's on screen DURING the stall.
          keys: [
            [2500, 'hello there\r'],
            [5500, 'mid-task note\r'],   // inside the 2.5s stall window
            [10000, '/quit\r'],
            [13000, '/quit\r'],          // in case a prompt consumed the first
          ],
        },
      );
      let buf = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pty timed out; output tail: ${buf.slice(-400)}`)); }, 30000);
      child.stdout.on('data', (b) => { buf += b.toString(); });
      child.stderr.on('data', (b) => { buf += b.toString(); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', () => { clearTimeout(timer); resolve(buf); });
    });

    // Assert on ANSI-STRIPPED text: the box label is two styled spans, so
    // '»' and ' add instruction' are never contiguous in the raw byte stream.
    const plainOut = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.ok(plainOut().includes('» add instruction'),
      `the reserved input-box row appeared during the turn; tail: ${plainOut().slice(-500)}`);
    assert.ok(plainOut().includes('queued #1'), 'the mid-task line produced the queued receipt');
    assert.ok(plainOut().includes('working on it'), 'the stalled stream eventually delivered its answer');
    // The draft echoed KEY BY KEY into the reserved row (the private
    // rl.line/refreshInputLine path actually rendering).
    assert.ok(/» add instruction mid/.test(plainOut()), 'keystrokes echoed into the box row');
  } finally {
    mock.server.close();
    fsSync.rmSync(src, { recursive: true, force: true });
  }
});

test('pty parity: the SAME scenario on the TUI front-end (message → mid-task queue → answer → clean exit)', { skip: !hasScript }, async () => {
  // The project + KB from the first test still stand (HOME is shared and
  // cleaned up once at the end of the file). Fresh mock + model pointing at
  // it, then drive the inline TUI through the identical interaction.
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
        `stty rows 30 cols 100 2>/dev/null; exec node ${JSON.stringify(CLI)} --tui`,
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            HK2_ENABLE_QUERYREWRITE: '0',
            HK2_ENABLE_REQUEST_ASSESS: '0',
            HK2_AUTOIMPORT_CLAUDE: '0',
            HK2_HOME: HOME,
          },
          keys: [
            [2500, 'hello there\r'],
            [5500, 'mid-task note\r'],  // inside the stall window
            [10000, '/quit\r'],
            [13000, '/quit\r'],
          ],
        },
      );
      let buf = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pty timed out; tail: ${buf.slice(-400)}`)); }, 30000);
      child.stdout.on('data', (b) => { buf += b.toString(); });
      child.stderr.on('data', (b) => { buf += b.toString(); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ buf, code }); });
    });

    const plain = out.buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.equal(out.code, 0, `clean exit; tail: ${plain.slice(-300)}`);
    assert.ok(plain.includes('❯ hello there'), 'the TUI echoes the submitted prompt into the scrollback');
    assert.ok(plain.includes('queued #1'), 'PARITY: the mid-task line produced the same queued receipt as the REPL');
    assert.ok(plain.includes('working on it'), 'the stalled stream delivered its answer');
  } finally {
    mock.server.close();
  }
});

// The shared HOME outlives both tests by design; nothing else to do here
// (rmSync of HOME is intentionally NOT run so the file stays single-purpose
// — the temp dir is under os.tmpdir() and the OS reaps it).
