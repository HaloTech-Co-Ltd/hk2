/*-------------------------------------------------------------------------
 *
 * PTY integration test for the REPL menu-during-resize rendering fix
 * (the kb_save_knowledge y/N confirmation bug).
 *
 * Reported symptoms (screenshot /tmp/hk2/issue_snapshot.png):
 *   - While the y/N "Write ... to eden space?" confirmation was on screen,
 *     resizing the terminal (big -> small -> big) made the confirm prompt
 *     VANISH; repeated Enter presses brought it back ON TOP of previous
 *     transcript output (11 duplicated prompt lines overwrote history).
 *   - The bottom status bar appeared TWICE, parked mid-screen instead of at
 *     the bottom.
 *
 * Root causes (byte-verified):
 *   1. Node readline listens on its OUTPUT stream's 'resize' and re-runs
 *      _refreshLine: \x1b[1G\x1b[0J (an UNBOUNDED ED erase that ignores the
 *      DECSTBM scroll region) + the MAIN prompt — wiping the menu prompt and
 *      everything below it, then re-echoing the wrong prompt.
 *   2. StatusBar._rows() preferred process.stdout.rows, which lags behind the
 *      draw stream on resize -> the bar painted at the OLD row on the NEW
 *      screen (duplicate, mid-screen).
 *   3. After a shrink the pre-resize DECSC slot was stale/invalid: the tail
 *      \x1b8 parked the cursor inside the reserved block; the next Enter
 *      scrolled the reserved block up over the transcript.
 *
 * The fix: gate readline's native redraw while a menu owns the input
 * (bounded CR+EL menu-row redraw instead), derive geometry from the DRAW
 * stream, wipe old-geometry rows on height changes, and re-anchor + re-emit
 * the menu prompt at the new workspace bottom.
 *
 * Sequence: boot the line REPL under a pty -> first message -> the mock model
 * proposes a kb_save_knowledge(eden) entry -> y/N menu appears -> resize
 * 30->12->30 via background stty -> answer 'n' -> the turn finishes -> /quit.
 *
 * Run: node --test test/repl_resize_menu_pty.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';

import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert';
import { ptyAvailable, spawnPty } from './_pty_runner.js';

const HOME = fsSync.mkdtempSync(path.join(os.tmpdir(), 'hk2-menusize-pty-'));
process.env.HK2_HOME = HOME;

const { registerProject, setCurrentProject, ensureHome, saveModels } = await import('../lib/config/home.js');
const { addKbForProject } = await import('../lib/index/registry.js');
const { buildIndex } = await import('../lib/index/indexer.js');

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, '..', 'bin', 'hk2');
const hasScript = ptyAvailable();

/**
 * Mock OpenAI-style SSE server. Call 1 proposes a kb_save_knowledge(eden)
 * tool call, then (once the tool result comes back) call 2 answers plainly.
 * The tool-call response is sent SLOWLY (drip the tool_call delta) so the
 * y/N menu is reliably on screen when the resize lands.
 */
function mockLlmServer() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (calls === 1) {
      // Round 1: propose the knowledge save. The REPL will surface the y/N
      // menu (kb_save_knowledge -> eden with HK2_ENABLE_AUTO_LEARN unset).
      const args = JSON.stringify({
        space: 'eden',
        id: 'pty-resize-menu-probe',
        title: 'pty resize menu probe',
        intro: 'probe entry used by the resize-menu pty test only',
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'kb_save_knowledge', arguments: '' } }] } }] })}\n\n`);
      // Drip the arguments slowly so the menu appears well after this chunk.
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }, { finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, 600);
      return;
    }
    // Round 2+: the user declined the save; finish the turn with plain text.
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'declined noted' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }, { finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('pty: y/N knowledge-save menu survives a big->small->big resize without wiping the screen', { skip: !hasScript }, async () => {
  const src = fsSync.mkdtempSync(path.join(os.tmpdir(), 'hk2-menusize-src-'));
  fsSync.writeFileSync(path.join(src, 'one.js'), 'export function alpha() { return 1; }\n');
  await ensureHome();
  const p = await registerProject({ sourcePath: src, name: 'menusize-pty' });
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
        // Background stty performs the resize from OUTSIDE the REPL process
        // (kernel TIOCSWINSZ -> SIGWINCH + stream refresh), 30 -> 12 -> 30.
        // The explicit < /dev/tty redirect is required: a backgrounded job's
        // stdin is /dev/null and stty would silently no-op.
        `stty rows 30 cols 100 2>/dev/null; (sleep 6.0; stty rows 12 cols 100 < /dev/tty; sleep 1.2; stty rows 30 cols 100 < /dev/tty) & exec node ${JSON.stringify(CLI)}`,
        {
          cwd: src,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            HK2_ENABLE_QUERYREWRITE: '0',
            HK2_ENABLE_REQUEST_ASSESS: '0',
            HK2_AUTOIMPORT_CLAUDE: '0',
            HK2_HOME: HOME,
          },
          keys: [
            [2500, 'save some knowledge\r'],  // triggers the kb_save_knowledge proposal
            [9500, 'n\r'],                    // answer the (resize-surviving) menu: decline
            [14000, '/quit\r'],
            [17000, '/quit\r'],               // in case a prompt consumed the first
          ],
        },
      );
      let buf = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pty timed out; output tail: ${buf.slice(-400)}`)); }, 40000);
      child.stdout.on('data', (b) => { buf += b.toString(); });
      child.stderr.on('data', (b) => { buf += b.toString(); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', () => { clearTimeout(timer); resolve(buf); });
    });

    const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

    // The menu WAS shown and answered: the decline notice proves the y/N
    // round-trip completed after the resize.
    assert.ok(plain().includes('Write "pty-resize-menu-probe" to eden space?'),
      `the y/N menu prompt appeared; tail: ${plain().slice(-500)}`);
    assert.ok(plain().includes('Cancelled - nothing was written to the KB.'),
      'the decline was processed (menu answered after the resize)');
    assert.ok(plain().includes('declined noted'), 'the follow-up round finished the turn');

    // THE bug signature: the menu prompt must NOT be spammed. Pre-fix, each
    // idle Enter re-echoed it (11+ copies) over the transcript.
    const promptCopies = plain().split('Write "pty-resize-menu-probe" to eden space?').length - 1;
    assert.ok(promptCopies <= 3,
      `menu prompt not spammed (${promptCopies} copies; pre-fix bug showed 5-11)`);

    // No unbounded ED wipe DURING the menu window (menu shown -> answered):
    // readline's native resize redraw is gated while the menu owns the input.
    // (After the answer the idle-turn rl.prompt() legitimately refreshes.)
    const menuAt = out.indexOf('Write "pty-resize-menu-probe" to eden space?');
    const cancelAt = plain().indexOf('Cancelled - nothing was written');
    const rawCancelAt = out.indexOf('Cancelled - nothing was written', menuAt);
    const menuWindow = out.slice(menuAt, rawCancelAt > 0 ? rawCancelAt : undefined);
    assert.ok(!menuWindow.includes('\x1b[0J'),
      `no ED screen-wipe while the menu was active (window ${menuAt}..${rawCancelAt}); cancel plain-text at ${cancelAt}`);

    // The status bar settled at the FINAL geometry (30 rows): the last status
    // paint addresses row 30, not a stale mid-screen row.
    const statusParks = out.match(/\x1b\[\d+;1H[^\x1b]*idle/g) || [];
    if (statusParks.length > 0) {
      const last = statusParks[statusParks.length - 1];
      assert.ok(last.startsWith('\x1b[30;1H'),
        `final idle status line parked at row 30 (got ${JSON.stringify(last)})`);
    }
  } finally {
    mock.server.close();
    fsSync.rmSync(src, { recursive: true, force: true });
  }
});
