/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 *-------------------------------------------------------------------------
 * Workaround for a Node readline bug that corrupts MID-LINE edits fed by
 * multi-character input chunks.
 *
 * Bug (node v24.10, lib/internal/readline/emitKeypressEvents.js onData):
 * when one data event carries MULTIPLE characters — exactly what an IME
 * commit looks like: 继续开始R1 cursor mid-line, then 推进 arrives as ONE
 * chunk — readline replays the characters with `iface.isCompletionEnabled
 * = false`, re-enabling it only for the LAST character. kInsertString then
 * takes the completion-disabled fast path `this.line += c` for every char
 * except the last: they are APPENDED AT END OF LINE, ignoring the cursor.
 * The last char is spliced at the (per-char advanced) cursor. Result:
 * 推 lands at end-of-line, 进 lands at cursor+1 → 继续开始R进1推 instead of
 * 继续开始推进R1. ASCII typed key-by-key is one char per chunk, so it was
 * never broken — the exact 中文删改后再输入就错乱 report.
 *
 * Fix: track the edit state at the end of every synchronous keystroke
 * burst; when a burst consisted ONLY of plain characters and the resulting
 * line is not the correct at-cursor splice (checked by length, so the
 * repair can never fire on unrelated edits), rewrite line/cursor to the
 * splice and refresh. Bursts containing named keys (arrows, enter,
 * paste markers, …) are left to readline/PasteHandler untouched.
 *-------------------------------------------------------------------------*/

/**
 * Install the burst-insert repair on a readline Interface. Returns an
 * uninstall function. Fails soft: a missing input stream or a runtime
 * without the private _refreshLine keeps today's behavior (repair skips
 * the redraw but still fixes the edit state).
 */
export function repairBurstInserts(rl) {
  if (!rl || typeof rl.input?.on !== 'function') return () => {};
  let last = { line: rl.line ?? '', cursor: rl.cursor ?? 0 };
  let burst = '';     // plain chars of the current synchronous burst
  let tainted = false; // any non-printable key seen in this burst
  let scheduled = false;

  const finish = () => {
    scheduled = false;
    const chars = burst;
    const bad = tainted;
    burst = '';
    tainted = false;
    if (!bad && chars.length > 0) {
      const expected = last.line.slice(0, last.cursor) + chars + last.line.slice(last.cursor);
      // Length equality is the safety gate: the Node bug only ever MOVES the
      // burst chars, so a length mismatch means something else edited the
      // line in between — leave it alone.
      if (rl.line !== expected && rl.line.length === expected.length) {
        rl.line = expected;
        rl.cursor = last.cursor + chars.length;
        try { rl._refreshLine(); } catch { /* output gone */ }
      }
    }
    last = { line: rl.line ?? '', cursor: rl.cursor ?? 0 };
  };

  const onKey = (str, key) => {
    if (!scheduled) {
      scheduled = true;
      process.nextTick(finish);
    }
    // Printable-char events: readline sets key.name to the lowercased LETTER
    // for ASCII ('X' → name 'x') but leaves it undefined for non-ASCII, so
    // "has a name" cannot reject chars. Named control keys (left/enter/tab/
    // paste-start/…) all have multi-char names or fail `str >= ' '`.
    const plain = typeof str === 'string' && str.length > 0 && str >= ' '
      && !key?.ctrl && !key?.meta
      && (!key?.name || key.name === 'space' || key.name.length === 1);
    if (plain) {
      burst += str;
    } else {
      tainted = true;
    }
  };

  rl.input.on('keypress', onKey);
  return () => { rl.input.off('keypress', onKey); };
}
