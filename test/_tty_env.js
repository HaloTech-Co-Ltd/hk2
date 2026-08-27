/*-------------------------------------------------------------------------
 *
 * Test prelude: force a capability-bearing TERM for tests that assert
 * TTY/ANSI output bytes (Frame geometry, screen-model replay). Without
 * this, running the suite under TERM=dumb disables style/Frame and the
 * byte-level assertions fail — capability must not depend on the shell
 * that launched the test run. Import this FIRST (before anything that
 * pulls in lib/agent/style.js or src/tui/*).
 *
 *----------------------------------------------------------------------*/
if (process.env.TERM === 'dumb' || !process.env.TERM) {
  process.env.TERM = 'xterm-256color';
}
