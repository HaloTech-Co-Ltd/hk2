/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 *-------------------------------------------------------------------------
 * Continuation-slot watchdog probe (REPL, fourth rendering defect).
 *
 * While the mid-task input box is docked, the interactive write-router
 * re-issues every workspace write as  DECRC + payload + DECSC + park  and
 * therefore trusts the DECSC slot blindly. A live session proved the slot
 * CAN drift into the reserved block with a healthy event loop — every
 * routed write then replayed tool-card output on top of the plan/status
 * rows and the display froze mid-task until the user interrupted.
 *
 * The probe asks the terminal WHERE the saved slot points:
 *
 *     ESC 8  ESC [6n  ESC 7  <park>      (restore slot, DSR-ask, re-save, dock)
 *
 * and judges the answer's row against the bar's geometry (workspace row =
 * healthy; reserved block row = drift -> heal; no answer = unknown ->
 * conservative heal, which is always safe: worst case the continuation
 * moves to a fresh row).
 *
 * INPUT ISOLATION — the "add instruction" R-injection regression:
 * a DSR answer is TERMINAL OUTPUT arriving on STDIN, the same stream
 * readline parses. Node's keypress matcher does not know ESC[r;cR and
 * re-emits it as keypress events ("R" among them), which corrupted the
 * mid-task draft exactly while the user was typing an instruction (the
 * original patch shared the stream; every probe sprayed stray R's).
 *
 * Each probe therefore opens a short ISOLATION WINDOW on stdin:
 *   - every other 'data'/'keypress'/'close'/'end' listener is detached
 *     (via rawListeners, so once-wrappers re-attach verbatim),
 *   - this module alone consumes the stream for <=160 ms,
 *   - well-formed DSR answers are decoded and consumed,
 *   - every OTHER byte the user typed during the window is REPLAYED
 *     byte-for-byte to readline when the window closes — zero keystrokes
 *     lost, zero probe bytes leaked. A chunk ending in a partial answer
 *     opener (ESC or ESC[) HOLDS those bytes back (they may complete an
 *     answer in the next chunk); held bytes unresolved at window close are
 *     replayed too (an ESC is the interrupt key — never drop user keys).
 *
 * Known limit: a DSR answer arriving AFTER the window timed out is no
 * longer filtered (readline may show its tail as one stray keypress). Only
 * misbehaving terminals that answer late hit this; the conservative heal
 * has already re-banked the slot by then, so no state is corrupted.
 *-------------------------------------------------------------------------*/

/**
 * Install the slot probe on a StatusBar. `stdin` is the readline input
 * stream (rl.input); `bar` a started StatusBar. The bar's poll watchdog
 * invokes the probe while the input box is docked (see StatusBar.poll).
 * Returns a cleanup function that must be called on REPL shutdown.
 */
export function installSlotProbe(stdin, bar) {
  if (!stdin || typeof stdin.on !== 'function' || !bar) return () => {};

  const DSR_ANSWER = /\x1b\[\d+;\d+R/g; // a whole, well-formed answer
  let detached = [];   // [event, rawListener] pairs removed for a window
  let replay = [];     // user bytes to hand back when the window closes
  let carry = '';      // chunk tail held back: may open a DSR answer
  let buf = '';        // raw assembly for the whole-answer regex
  let open = false;    // isolation window active
  let pending = 0;     // probes awaiting a verdict
  let timer = null;    // one-shot timeout handle

  const emitData = (chunk) => { try { stdin.emit('data', chunk); } catch { /* gone */ } };

  const closeWindow = () => {
    open = false;
    // Remove the window's own listener FIRST: the replay below must reach
    // readline only, and post-window chunks must not re-enter this module.
    try { stdin.removeListener('data', onWindowData); } catch { /* gone */ }
    for (const [ev, fn] of detached) {
      try { stdin.on(ev, fn); } catch { /* stream gone */ }
    }
    detached = [];
    // Held-back opener bytes that never completed an answer were USER keys.
    if (carry.length > 0) { replay.push(carry); carry = ''; }
    const chunks = replay;
    replay = [];
    for (const chunk of chunks) emitData(chunk);
  };

  const finish = (healthy, rows) => {
    if (!open) return;
    pending = 0;
    if (timer) { clearTimeout(timer); timer = null; }
    closeWindow();
    try { bar.slotProbeResult(healthy, rows); } catch { /* bar gone */ }
  };

  // The window's exclusive stdin listener.
  const onWindowData = (chunk) => {
    const raw = String(chunk);
    const rawStart = buf.length;   // this chunk's origin in buf (buf is
                                   // window-scoped and never trimmed)
    buf += raw;
    let m;
    const whole = /\x1b\[(\d+);(\d+)R/g;
    while ((m = whole.exec(buf)) !== null) {
      if (pending > 0) {
        const row = parseInt(m[1], 10);
        let verdict;
        try { verdict = bar.slotProbeHealthyRow(row); } catch { verdict = undefined; }
        if (verdict !== undefined) {
          // First answer closes the window. Replay ONLY this chunk's bytes
          // that are not part of it (earlier chunks were already buffered
          // by the tail rule; their held-back openers live in `carry`).
          const answerEnd = m.index + m[0].length;
          let rest = buf.slice(rawStart, Math.max(rawStart, m.index));
          if (answerEnd < buf.length) rest += buf.slice(answerEnd);
          if (m.index >= rawStart && carry.length > 0) {
            // The answer lies wholly inside this chunk, so the held-back
            // opener did NOT complete an answer — it was a user key.
            rest = carry + rest;
          }
          carry = '';
          buf = '';
          if (rest.length > 0) replay.push(rest);
          finish(verdict, undefined);
          return;
        }
      }
    }
    // No verdict yet: strip whole answers, hold a trailing answer-opener
    // back (it may complete an answer in the next chunk).
    const s = carry + raw;
    carry = '';
    const stripped = s.replace(DSR_ANSWER, '');
    if (stripped.endsWith('\x1b[')) {
      carry = '\x1b[';
      if (stripped.length > 2) replay.push(stripped.slice(0, -2));
    } else if (stripped.endsWith('\x1b')) {
      carry = '\x1b';
      if (stripped.length > 1) replay.push(stripped.slice(0, -1));
    } else if (stripped.length > 0) {
      replay.push(stripped);
    }
  };

  const probe = () => {
    if (open || pending > 0) return; // one window at a time
    detached = [];
    for (const ev of stdin.eventNames()) {
      if (ev !== 'data' && ev !== 'keypress' && ev !== 'close' && ev !== 'end') continue;
      for (const fn of stdin.rawListeners(ev)) {
        stdin.removeListener(ev, fn);
        detached.push([ev, fn]);
      }
    }
    open = true;
    pending = 1;
    buf = '';
    replay = [];
    carry = '';
    stdin.on('data', onWindowData);
    // rawWrite bypasses the interactive write-router (captured before any
    // wrapper), so the probe sequence reaches the terminal unmolested.
    bar.rawWrite('\x1b8\x1b[6n\x1b7');
    const park = typeof bar.parkSeq === 'function' ? bar.parkSeq() : null;
    if (park) bar.rawWrite(park);
    timer = setTimeout(() => {
      timer = null;
      if (pending > 0) finish(false, undefined); // silent terminal: unknown
    }, 160);
  };

  bar.setSlotProbeFn(probe);

  return () => {
    try { stdin.removeListener('data', onWindowData); } catch { /* gone */ }
    if (timer) { clearTimeout(timer); timer = null; }
    if (open) {
      // Shutdown mid-window: re-attach readline's listeners rather than
      // discarding them (a dropped data listener would silently kill all
      // further input processing on that stream).
      open = false;
      const toReattach = detached;
      detached = [];
      for (const [ev, fn] of toReattach) {
        try { stdin.on(ev, fn); } catch { /* stream gone */ }
      }
      replay = [];
      pending = 0;
    }
    try { bar.setSlotProbeFn(null); } catch { /* bar gone */ }
  };
}
