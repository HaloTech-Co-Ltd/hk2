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
 * The timeout path closes the window conservatively (heal) and then arms
 * a POST-WINDOW STRAGGLER FILTER — a second, bounded mini-window that owns
 * stdin and strips exactly the pending DSR answer when it finally arrives
 * (libuv runs the timeout timer BEFORE same-batch tty reads when the main
 * thread was blocked by tool output; without the filter the late answer's
 * printable 'R' hit the draft — the live "R reappeared" recurrence). Its
 * tail-holdback runs only on the first chunk; the hunt is chunk-bounded and
 * self-disarms, replaying every non-answer byte to readline byte-exact.
 * A mid-window REPL shutdown arms the same filter for its pending answer.
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
  // A chunk tail that could still COMPLETE into a DSR answer — a lone ESC
  // (byte-split answers open with it) or ESC[ + digits/semicolons (any
  // prefix of that shape). Held back so a split answer is consumed as probe
  // traffic instead of leaking its tail digits / 'R' into readline's draft
  // (the observed `0R2R4R6R8R…7R7R7R` fragmentation leak). An ESC held back
  // is replayed at window close if nothing completes — the interrupt key is
  // never dropped, only briefly delayed (window ≤ 160 ms).
  const ANSWER_PREFIX_TAIL = /\x1b\[[\d;]*$|\x1b$/;
  let detached = [];   // [event, rawListener] pairs removed for a window
  let replay = [];     // user bytes to hand back when the window closes
  let carry = '';      // chunk tail held back: may open a DSR answer
  let buf = '';        // raw assembly for the whole-answer regex
  let open = false;    // isolation window active
  let pending = 0;     // probes awaiting a verdict
  let timer = null;    // one-shot timeout handle
  // Post-window straggler filter: armed while ONE late DSR answer may still
  // be in flight after the window closed (timeout heal, or a mid-window
  // shutdown). The wrapper consumes exactly one whole answer — including a
  // byte-split tail completing across chunks — then self-uninstalls; every
  // other byte passes through unchanged (byte-exact pass-through). Without
  // it, a straggler answer landed on readline's re-attached listener and its
  // printable 'R' hit the draft (the "R reappeared" live recurrence).
  let straggler = false;   // filter armed: owns the stream, hunting one answer
  let sreplay = [];        // passthrough bytes buffered while it owns the stream
  let schunks = 0;         // chunks seen while hunting (bounded by STRAGGLER_MAX_CHUNKS)
  // Bounded hunt: never own stdin forever. A filter whose held-back tail
  // keeps not completing an answer is likelier holding USER keys (a bare
  // ESC, an arrow prefix); after this many chunks it gives the stream back.
  const STRAGGLER_MAX_CHUNKS = 8;

  const emitData = (chunk) => { try { stdin.emit('data', chunk); } catch { /* gone */ } };

  const armStraggler = () => {
    // Mini-window: detach every other stdin listener (same set as probe())
    // so the filter ALONE owns the stream — attaching alongside readline
    // would double-deliver passthrough bytes (emitData + readline's own
    // listener both firing). Passthrough bytes are buffered and replayed at
    // disarm, mirroring the window's replay contract.
    straggler = true;
    schunks = 0;
    sreplay = [];
    carry = ''; // stale held-back bytes belong to the discarded window
    detached = [];
    for (const ev of stdin.eventNames()) {
      if (ev !== 'data' && ev !== 'keypress' && ev !== 'close' && ev !== 'end') continue;
      for (const fn of stdin.rawListeners(ev)) {
        stdin.removeListener(ev, fn);
        detached.push([ev, fn]);
      }
    }
    stdin.on('data', onStragglerData);
  };

  const disarmStraggler = () => {
    if (!straggler) return;
    straggler = false;
    // Held-back tail bytes that never completed an answer were USER keys
    // (e.g. a bare ESC — the interrupt key): replay them, never drop.
    if (carry.length > 0) { sreplay.push(carry); carry = ''; }
    try { stdin.removeListener('data', onStragglerData); } catch { /* gone */ }
    const toReattach = detached;
    detached = [];
    for (const [ev, fn] of toReattach) {
      try { stdin.on(ev, fn); } catch { /* stream gone */ }
    }
    const chunks = sreplay;
    sreplay = [];
    for (const chunk of chunks) emitData(chunk); // readline is back: deliver
  };

  // Remove every whole DSR answer from `s`; also hold back a trailing
  // ANSWER_PREFIX_TAIL that could still complete into one. Returns the
  // pass-through bytes and whether a tail is now pending in `carry`.
  const stripAnswers = (s) => {
    let stripped = s.replace(DSR_ANSWER, '');
    let held = '';
    const tail = stripped.match(ANSWER_PREFIX_TAIL);
    if (tail) {
      held = tail[0];
      stripped = stripped.slice(0, stripped.length - tail[0].length);
    }
    return [stripped, held];
  };

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

  // Post-window straggler listener: while armed it owns stdin (readline's
  // listeners are detached). Each chunk is stripped of whole DSR answers;
  // everything else is buffered for replay. The tail-holdback runs ONLY on
  // the FIRST chunk — a byte-split answer's opener sits at a chunk boundary
  // — while later chunks never hold a trailing ESC/prefix back (a leftover
  // bare ESC after the answer was stripped is the USER's interrupt key, not
  // an answer opener; holding it re-triggers the tail rule forever). The
  // filter disarms — re-attaching readline and replaying the buffer — as
  // soon as a chunk resolves with no pending tail (answer consumed, or plain
  // user keys that were never an answer).
  const onStragglerData = (chunk) => {
    if (!straggler) return;
    const raw = String(chunk);
    if (carry.length === 0) {
      // First look: strip whole answers; hold back only a TRAILING prefix
      // that could still complete into one (byte-split opener).
      const [pass, held] = stripAnswers(raw);
      if (pass.length > 0) sreplay.push(pass);
      if (held.length > 0) { carry = held; return; } // hunting the completion
      disarmStraggler();
      return;
    }
    // Completing a held-back tail: strip whole answers from the joined
    // bytes; whatever remains (including an ESC that never completed an
    // answer) passes through — no NEW tail holdback on later chunks.
    const s = carry + raw;
    carry = '';
    const stripped = s.replace(DSR_ANSWER, '');
    if (stripped.length > 0) sreplay.push(stripped);
    disarmStraggler();
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
          // that are not probe traffic (earlier chunks were already buffered
          // by the tail rule; their held-back openers live in `carry`). Any
          // ADDITIONAL whole answer sharing the chunk is terminal traffic
          // too — consume it, never replay it.
          const answerEnd = m.index + m[0].length;
          let rest = buf.slice(rawStart, Math.max(rawStart, m.index));
          if (answerEnd < buf.length) rest += buf.slice(answerEnd);
          rest = rest.replace(DSR_ANSWER, '');
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
    // No verdict yet: strip whole answers, hold back any tail that could
    // still complete into an answer (it may complete in the next chunk).
    const s = carry + raw;
    carry = '';
    const stripped = s.replace(DSR_ANSWER, '');
    const held = stripped.match(ANSWER_PREFIX_TAIL);
    if (held) {
      carry = held[0];
      const head = stripped.slice(0, stripped.length - held[0].length);
      if (head.length > 0) replay.push(head);
    } else if (stripped.length > 0) {
      replay.push(stripped);
    }
  };

  const probe = () => {
    if (open || pending > 0) return; // one window at a time
    // A straggler filter left armed from a previous timed-out probe must be
    // dismantled BEFORE this window detaches listeners: probe() would
    // otherwise snapshot onStragglerData as if it were readline's listener,
    // and closeWindow would re-attach IT instead of readline's — stdin goes
    // permanently deaf (the after-timeout probe#2 regression).
    if (straggler) disarmStraggler();
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
      if (pending > 0) {
        // Timeout heal: the answer may still be in flight. A blocked main
        // thread (tool output, tree-sitter parse) defers the tty read; when
        // the loop unblocks, libuv runs this timer BEFORE the 'data' event
        // delivers the straggler. Close the window FIRST (listeners back,
        // replay delivered), THEN arm the straggler filter — arming before
        // the close would let it intercept the replay bytes.
        finish(false, undefined); // silent terminal: unknown
        armStraggler();
      }
    }, 160);
  };

  bar.setSlotProbeFn(probe);

  return () => {
    try { stdin.removeListener('data', onWindowData); } catch { /* gone */ }
    try { stdin.removeListener('data', onStragglerData); } catch { /* gone */ }
    if (timer) { clearTimeout(timer); timer = null; }
    if (open) {
      // Shutdown mid-window: re-attach readline's listeners rather than
      // discarding them (a dropped data listener would silently kill all
      // further input processing on that stream). Order matters: re-attach
      // FIRST, then (below) arm the straggler filter, which re-detaches into
      // its own snapshot — arming first would clobber the shared `detached`
      // array and lose readline's listeners forever.
      open = false;
      const toReattach = detached;
      detached = [];
      for (const [ev, fn] of toReattach) {
        try { stdin.on(ev, fn); } catch { /* stream gone */ }
      }
      replay = [];
      if (pending > 0) {
        // The window never got its answer; one may still arrive after this
        // shutdown — keep the straggler filter armed so it cannot reach
        // readline either (the R-recurrence path when the REPL exits or is
        // Ctrl+Z'd mid-probe).
        armStraggler();
      }
      pending = 0;
    }
    try { bar.setSlotProbeFn(null); } catch { /* bar gone */ }
  };
}
