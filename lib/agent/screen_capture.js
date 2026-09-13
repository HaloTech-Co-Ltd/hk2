/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. See the license file for
 * details.
 *
 *-------------------------------------------------------------------------*/

/**
 * Cross-platform LIVE screen capture for the vision tool suite.
 *
 * Two entry points used by lib/agent/vision_tools.js:
 *   captureScreen()            → one PNG screenshot of the current screen
 *   recordScreen({ seconds })  → a short screen recording (mov/mp4)
 *
 * Both return { ok: true, path, kind } on success or { ok: false, error }
 * with an actionable, English-only message on failure — the pure-error
 * contract every vision tool follows. The output is a TEMPORARY file in
 * os.tmpdir(); the caller (runVisionTool) deletes it right after the
 * analysis completes (success or failure).
 *
 * Platform matrix:
 *   macOS     screenshot: `screencapture -x -t png <file>`
 *             recording: `screencapture -x -v -V<seconds> <file.mov>`
 *             (both built in; the terminal needs the Screen Recording
 *              permission — an empty/failed capture reports that hint)
 *   Windows   screenshot: PowerShell + System.Drawing CopyFromScreen → PNG
 *             recording: ffmpeg gdigrab (`-t <seconds>`), ffmpeg required
 *   Linux     screenshot: first available of gnome-screenshot / spectacle /
 *             scrot / grim (Wayland) / import (ImageMagick)
 *             recording: ffmpeg x11grab on X11 sessions only — Wayland
 *             recording is explicitly unsupported with a clear message
 *
 * Recordings are bounded: 1-60 seconds (default 10), and the recorder
 * process is killed after the duration plus a grace window so a wedged
 * helper can never hang the agent turn forever.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

/** Recording duration bounds (seconds). */
export const RECORD_MIN_SECONDS = 1;
export const RECORD_MAX_SECONDS = 60;
export const RECORD_DEFAULT_SECONDS = 10;

/**
 * Extra seconds granted to a recorder process beyond the requested
 * duration before it is killed (encoder startup, container finalization).
 */
const RECORD_GRACE_SECONDS = 25;

/** Unique temp-file path for one capture. */
function tmpFile(ext) {
  const rand = Math.random().toString(36).slice(2, 10);
  return path.join(tmpdir(), `hk2-screen-${Date.now()}-${process.pid}-${rand}.${ext}`);
}

function fail(error) {
  return { ok: false, error };
}

/**
 * Validate + normalize a requested recording duration.
 * @returns {number} seconds, or {{error: string}} when out of range.
 */
export function normalizeSeconds(raw) {
  if (raw === undefined || raw === null || raw === '') return RECORD_DEFAULT_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < RECORD_MIN_SECONDS || n > RECORD_MAX_SECONDS) {
    return { error: `seconds must be a number between ${RECORD_MIN_SECONDS} and ${RECORD_MAX_SECONDS} (got ${JSON.stringify(raw)})` };
  }
  return Math.round(n);
}

/** Friendly one-line summary of the current platform's capture backend. */
export function captureBackendSummary() {
  switch (process.platform) {
    case 'darwin':
      return 'macOS screencapture';
    case 'win32':
      return 'Windows PowerShell/System.Drawing; recording additionally needs ffmpeg';
    default:
      return 'Linux screenshot utilities; recording needs ffmpeg + an X11 session (Wayland recording unsupported)';
  }
}

/** Best-effort removal of a temp file; never throws. */
async function removeQuiet(file) {
  try { await rm(file, { force: true }); } catch { /* best effort */ }
}

/**
 * Verify the capture helper actually produced a non-empty file; otherwise
 * report the most likely cause (permissions) with a fix hint.
 */
async function verify(file, kind) {
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size === 0) throw new Error('empty output');
    return { ok: true, path: file, kind };
  } catch {
    await removeQuiet(file);
    return fail(
      `${kind} produced no output — on macOS grant the Screen Recording permission to the terminal `
      + '(System Settings → Privacy & Security → Screen Recording) and retry; '
      + 'on Linux check the session/display; on Windows try a non-elevated terminal',
    );
  }
}

/** Turn a child_process error into an actionable message. */
function describeSpawnError(platform, err, kind, seconds) {
  if (err.killed || err.signal === 'SIGKILL') {
    return `${kind} timed out${seconds ? ` (after ${seconds}s + grace window)` : ''} and was terminated — try a shorter duration or check screen-privacy settings`;
  }
  if (err.code === 'ENOENT') {
    return `${kind} failed: helper not found (${err.path || 'spawn target'}) — it should ship with the OS; check PATH`;
  }
  const stderr = String(err.stderr || err.message || '').trim();
  const hint = platform === 'darwin'
    ? ' — on macOS grant the Screen Recording permission to the terminal (System Settings → Privacy & Security → Screen Recording) and retry'
    : '';
  return `${kind} failed: ${stderr || `exit code ${err.code}`}${hint}`;
}

/** Windows screenshot via PowerShell + System.Drawing (all monitors → one bitmap). */
function powershellScreenshotScript(file) {
  const target = String(file).replace(/'/g, "''");
  return [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height)',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size)',
    `$bmp.Save('${target}',[System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join('; ');
}

/**
 * Linux screenshot: try the known utilities in order; the first that
 * succeeds wins. Returns null on success or an error string.
 */
async function captureLinux(file) {
  const candidates = [
    ['gnome-screenshot', ['-f', file]],
    ['spectacle', ['-b', '-n', '-o', file]],
    ['scrot', [file]],
    ['grim', [file]],
    ['import', ['-window', 'root', file]],
  ];
  const problems = [];
  for (const [cmd, args] of candidates) {
    try {
      await run(cmd, args, { timeout: 30_000 });
      return null;
    } catch (err) {
      problems.push(err.code === 'ENOENT' ? `${cmd}: not installed` : `${cmd}: ${String(err.stderr || err.message).trim()}`);
    }
  }
  return `no usable screenshot utility on Linux — tried: ${problems.join('; ')} `
    + '(install one of gnome-screenshot, spectacle, scrot, grim or imagemagick)';
}

/** Whether ffmpeg is reachable in PATH. */
async function probeFfmpeg() {
  try {
    await run('ffmpeg', ['-version'], { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture one PNG screenshot of the current screen.
 * @returns {Promise<{ok:true, path:string, kind:'screenshot'}|{ok:false, error:string}>}
 */
export async function captureScreen() {
  const platform = process.platform;
  const file = tmpFile('png');
  try {
    if (platform === 'darwin') {
      await run('screencapture', ['-x', '-t', 'png', file], { timeout: 30_000, killSignal: 'SIGKILL' });
    } else if (platform === 'win32') {
      await run(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powershellScreenshotScript(file)],
        { timeout: 45_000, killSignal: 'SIGKILL' },
      );
    } else {
      const err = await captureLinux(file);
      if (err) {
        await removeQuiet(file);
        return fail(err);
      }
    }
  } catch (err) {
    await removeQuiet(file);
    return fail(describeSpawnError(platform, err, 'screenshot'));
  }
  return verify(file, 'screenshot');
}

/**
 * Record the current screen for a bounded duration.
 * @param {{seconds?: number|string}} opts requested duration (1-60, default 10)
 * @returns {Promise<{ok:true, path:string, kind:'recording'}|{ok:false, error:string}>}
 */
export async function recordScreen(opts = {}) {
  const secs = normalizeSeconds(opts.seconds);
  if (typeof secs === 'object' && secs.error) return fail(secs.error);

  const platform = process.platform;
  const file = tmpFile(platform === 'darwin' ? 'mov' : 'mp4');
  const timeoutMs = (secs + RECORD_GRACE_SECONDS) * 1000;

  try {
    if (platform === 'darwin') {
      await run('screencapture', ['-x', '-v', `-V${secs}`, file], { timeout: timeoutMs, killSignal: 'SIGKILL' });
    } else if (platform === 'win32') {
      if (!(await probeFfmpeg())) {
        await removeQuiet(file);
        return fail('ffmpeg was not found in PATH — screen recording on Windows requires ffmpeg (screenshot capture works without it)');
      }
      await run(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', '10', '-i', 'desktop', '-t', String(secs), '-pix_fmt', 'yuv420p', file],
        { timeout: timeoutMs, killSignal: 'SIGKILL' },
      );
    } else {
      if ((process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland') {
        await removeQuiet(file);
        return fail('screen recording under a Wayland session is not supported — record in an X11 session, or capture still screenshots with capture_and_analyze instead');
      }
      if (!(await probeFfmpeg())) {
        await removeQuiet(file);
        return fail('ffmpeg was not found in PATH — screen recording on Linux requires ffmpeg (install it, or capture still screenshots with capture_and_analyze)');
      }
      const display = process.env.DISPLAY || ':0.0';
      await run(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '10', '-i', display, '-t', String(secs), '-pix_fmt', 'yuv420p', file],
        { timeout: timeoutMs, killSignal: 'SIGKILL' },
      );
    }
  } catch (err) {
    await removeQuiet(file);
    return fail(describeSpawnError(platform, err, 'recording', secs));
  }
  return verify(file, 'recording');
}
