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
 * Skipped when `script` is unavailable. Run: node --test test/repl_midtask_pty.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';

// HK2_HOME must be pinned BEFORE lib/config/home.js is imported (it freezes
// the path at module load) — this file manages its own isolation instead of
// using _learn_setup, which other suites mutate.
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert';

const HOME = fsSync.mkdtempSync(path.join(os.tmpdir(), 'hk2-midtask-pty-'));
process.env.HK2_HOME = HOME;

const { registerProject, setCurrentProject, ensureHome, saveModels } = await import('../lib/config/home.js');
const { addKbForProject } = await import('../lib/index/registry.js');
const { buildIndex } = await import('../lib/index/indexer.js');

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, '..', 'bin', 'hk2');

const hasScript = spawnSync('which', ['script'], { stdio: 'ignore' }).status === 0;

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
      const child = spawn('script', [
        '-qec',
        `stty rows 30 cols 100 2>/dev/null; exec node ${JSON.stringify(CLI)}`,
        '/dev/null',
      ], {
        cwd: src,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          HK2_ENABLE_QUERYREWRITE: '0',
          HK2_ENABLE_REQUEST_ASSESS: '0',
          HK2_AUTOIMPORT_CLAUDE: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buf = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pty timed out; output tail: ${buf.slice(-400)}`)); }, 30000);
      child.stdout.on('data', (b) => { buf += b.toString(); });
      child.stderr.on('data', (b) => { buf += b.toString(); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', () => { clearTimeout(timer); resolve(buf); });

      // Boot → first message → (turn stalls on the mock) second line → quit.
      // Generous waits: under `node --test` the machine is busier than a bare
      // shell, and the whole point is what's on screen DURING the stall.
      const send = (s) => child.stdin.write(s);
      setTimeout(() => send('hello there\r'), 2500);
      setTimeout(() => send('mid-task note\r'), 5500);   // inside the 2.5s stall window
      setTimeout(() => send('/quit\r'), 10000);
      setTimeout(() => send('/quit\r'), 13000);          // in case a prompt consumed the first
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
    fsSync.rmSync(HOME, { recursive: true, force: true });
    fsSync.rmSync(src, { recursive: true, force: true });
  }
});
