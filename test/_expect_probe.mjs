import { spawn, spawnSync } from 'node:child_process';

console.log('which expect:', spawnSync('which', ['expect'], { stdio: 'ignore' }).status === 0 ? 'yes' : 'no');

// Probe A: exit-code propagation through expect
const a = spawn('expect', ['-c', [
  'log_user 0',
  'spawn /bin/sh -c {echo EXP_OK; exit 5}',
  'log_user 1',
  'expect eof',
  'catch {wait} w',
  'exit [lindex $w 3]',
].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] });
let ab = '';
a.stdout.on('data', (x) => { ab += x; });
a.stderr.on('data', (x) => { ab += x; });
a.on('close', (c) => {
  console.log(`probeA exit=${c} out=${JSON.stringify(ab)}`);

  // Probe B: timed sends into the pty (the pattern the tests need)
  const b = spawn('expect', ['-c', [
    'set timeout -1',
    'log_user 0',
    'spawn /bin/sh -c {read x; echo GOT=$x; exit 0}',
    'log_user 1',
    'after 300',
    'send -- {feedme\\r}',
    'expect eof',
    'catch {wait} w2',
    'exit [lindex $w2 3]',
  ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let bb = '';
  b.stdout.on('data', (x) => { bb += x; });
  b.stderr.on('data', (x) => { bb += x; });
  b.on('close', (c2) => {
    console.log(`probeB exit=${c2} out=${JSON.stringify(bb)}`);

    // Probe C: stty sizing + ANSI passthrough
    const c3 = spawn('expect', ['-c', [
      'set timeout -1',
      'log_user 0',
      'spawn /bin/sh -c {stty rows 30 cols 100 2>/dev/null; stty size; printf "\\033\[?2004l"; exit 0}',
      'log_user 1',
      'expect eof',
      'catch {wait} w3',
      'exit [lindex $w3 3]',
    ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let cb = '';
    c3.stdout.on('data', (x) => { cb += x; });
    c3.stderr.on('data', (x) => { cb += x; });
    c3.on('close', (cc) => {
      console.log(`probeC exit=${cc} out=${JSON.stringify(cb)}`);
    });
  });
});
