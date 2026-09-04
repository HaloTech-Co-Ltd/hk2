/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频、图表、界面设计、版面框架、有关数据或电子文档等）
 * 均受中华人民共和国法律法规和相应的国际条约保护，易景科技享有上述知识产
 * 权，但相关权利人依照法律规定应享有的权利除外。未免疑义，本条所指的"知识
 * 产权"是指任何及所有基于 Halo 软件产生的：（a）版权、商标、商号、域名、与
 * 商标和商号相关的商誉、设计和专利；与创新、技术诀窍、商业秘密、保密技术、非
 * 技术信息相关的权利；（b）人身权、掩模作品权、署名权和发表权；以及（c）在
 * 本协议生效之前已存在或此后出现在世界任何地方的其他工业产权、专有权、与"知
 * 识产权"相关的权利，以及上述权利的所有续期和延长，无论此类权利是否已在相
 * 关法域内的相关机构注册。
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. Except as expressly permitted
 * in your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software or
 * in dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in dangerous
 * applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * CLI entry: argument parsing + dispatch.
 *
 * Default behavior: enter the interactive REPL.
 *
 * Usage:
 *   hk2                                     Enter interactive REPL (default)
 *   hk2 --project=<name>                    Enter REPL with the named project
 *   hk2 --project-id=<id>                   Enter REPL with the project whose id matches
 *   hk2 --project-list                      List all registered projects (name, id) and exit
 *   hk2 --mode=project-init --name=... --source=... [--source-root=...]
 *                                           Register a project from CLI
 *   hk2 --mode=build-kb [--source=<path>] [--source-root=<rel>]
 *                                           Build KB for the current project
 *   hk2 --mode=update-kb                     Incrementally update the KB
 *   hk2 --run-mode=serve                     Legacy REPL
 *   hk2 --help
 */
import { ensureHome, loadProjects } from '../lib/config/home.js';
import { VERSION } from './version.js';

const VALID_MODES = new Set(['project-init', 'build-kb', 'update-kb']);
const VALID_RUN_MODES = new Set(['once', 'serve']);

const BOOL_FLAGS = new Set(['help', 'h', 'project-list', 'version', 'V', 'tui', 'repl']);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (BOOL_FLAGS.has(key) || next === undefined || next.startsWith('--')) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printHelp() {
  console.log(`hk2 ${VERSION} - knowledge-base-driven coding agent

Default: enter the interactive REPL (agent loop with tool use + automatic KB context).

Usage:
  hk2
      Enter interactive REPL (default).

  hk2 --tui
      Enter the Claude Code-style inline TUI instead: a bordered multi-line
      input box pinned at the bottom, streaming markdown output, tool-call
      cards, slash-command completion, arrow-key confirmation modals, and a
      live status line. Keys: enter sends · \\ + enter continues a line ·
      up/down history · Tab completes · esc interrupts the running turn ·
      ctrl+c clears the input (press twice to exit). Needs a TTY terminal;
      falls back to the line REPL otherwise. Also enabled via HK2_UI=tui;
      --repl / HK2_UI=repl force the classic REPL.

  hk2 --project=<name>
  hk2 --project-id=<id>
      Enter the REPL with a specific project selected. <name> matches
      projects.json's name field; <id> matches the UUID. The chosen project
      is pinned for this session only — the shared current pointer in
      projects.json is NOT rewritten. Only one of the two flags may be
      given. Only meaningful with the default interactive mode (no --mode).

  hk2 --resume [<sessionId>]
      Resume a previous session: reopen its transcript and restore the full
      conversation context (messages, tool-call history, interrupted-task
      state). With no id, resumes the current project's LATEST session.
      Combine with --project/--project-id to resume a session from another
      project. Only meaningful with the default interactive mode.

  hk2 --project-list
      List all registered projects (name and id) and exit. The current
      project is marked with '*'. One-shot; does not enter the REPL.

  hk2 --mode=project-init --name=<name> --source=<path> [--source-root=<rel>]
      Register a new project from the command line (generates UUID, writes projects.json).
      Equivalent to: /project init inside the REPL.

  hk2 --mode=build-kb [--source=<path>] [--source-root=<rel>]
      Build KB for the current project (full re-index).

  hk2 --mode=update-kb
      Incrementally update the current project's KB.

  hk2 --run-mode=serve
      Legacy REPL (command-style, no agent loop).

  hk2 --version
      Print the version and exit.

  hk2 --help
      Print this help.

Interactive REPL commands (full list via /help; per-command usage via /help <command>):
  /model list | add | set | set-default | set-phase | types | use | del | show
  /project init | list | set | show | drop
  /kb init | update | status | search | symbol | neighbors | knowledge | transform | drop
  /session info | list | new | resume | compact
  /clear | /compact | /help | /quit

Session resume:
  hk2 --resume                     Resume the current project's latest session
  hk2 --resume <sessionId>         Resume a specific session by id
  hk2 --project=<name> --resume    Resume another project's latest session

Config locations:
  ~/.hk2/models.json           Multi-provider model registry
  ~/.hk2/projects.json         Project registry + current pointer
  ~/.hk2/kb/<projectId>/       Per-project KB (holy / eden / index spaces)
  ~/.hk2/sessions/<projectId>/<sessionId>.jsonl   Session transcripts

Environment variables:
  HK2_HOME              Override ~/.hk2 location
  HK2_KB_DIR            Override KB root (default ~/.hk2/kb)
  HK2_KB_NAME           KB name for legacy --mode commands
  HK2_PROJECT_SOURCE    Project source root for tool sandbox
  HK2_PLAN_TIMEOUT_MS   /kb knowledge learn Phase 1 planning timeout (ms;
                        default 300000; overridable per-run by --plan-timeout-ms)
  HK2_LLMAPI_TIMEOUT_MS  Default LLM API request timeout in ms (default
                        3600000 = 3600s; 0 = no timeout)
  HK2_KB_CHECKPOINT_INTERVAL  /kb init checkpoint cadence in files (default 100)
  HK2_DEBUG=1           Print error stacks
`);
}

/**
 * Launch the interactive front-end. Choice (highest priority first):
 *   --tui        Claude Code-style inline TUI (input box + streaming + modals)
 *   --repl       classic line REPL (the default)
 *   HK2_UI=tui   env fallback
 * The TUI needs raw-mode stdin + a TTY output + a real TERM; anything less
 * falls back to the REPL with a notice (piped stdin, TERM=dumb, some CI
 * consoles), which itself handles non-TTY input.
 */
async function launchFrontend(flags, opts) {
  const wantTui = flags.tui ? true : flags.repl ? false : process.env.HK2_UI === 'tui';
  if (wantTui) {
    const { runTui, tuiCapable } = await import('./tui/index.js');
    // The TUI draws on stderr by default (HK2_TUI_STREAM=stdout flips it);
    // judge capability against the stream it will actually use.
    const tuiStream = process.env.HK2_TUI_STREAM === 'stdout' ? process.stdout : process.stderr;
    if (tuiCapable(tuiStream)) {
      await runTui(opts);
      return;
    }
    console.error('[tui] this terminal does not support the TUI (needs a TTY stdin/output and TERM != dumb) — using the line REPL.');
  }
  const { interactive } = await import('./commands/interactive.js');
  await interactive(opts);
}

export async function run() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (flags.version || flags.V) {
    console.log(`${VERSION} (hk2)`);
    return;
  }

  if (flags.help || flags.h) {
    printHelp();
    return;
  }

  // --project-list: one-shot listing of all registered projects (name, id).
  // Resolved here (before the REPL) so it prints and exits cleanly.
  if (flags['project-list']) {
    await ensureHome();
    const { current, projects } = await loadProjects();
    const list = Object.values(projects || {});
    if (list.length === 0) {
      console.log('(no projects registered. Use: hk2 --mode=project-init --name=... --source=...)');
      return;
    }
    console.log(`Projects (current: ${current || '(none)'})`);
    for (const p of list) {
      const marker = p.id === current ? '* ' : '  ';
      console.log(`${marker}${p.name}  ${p.id}`);
    }
    return;
  }

  // Default: enter interactive REPL (no --mode and no --run-mode)
  if (!flags.mode && !flags['run-mode']) {
    await ensureHome();

    // --project=<name> / --project-id=<id>: select a specific project before
    // booting the REPL. Mutually exclusive. Resolved here (not inside
    // interactive()) so failures exit cleanly with a helpful message before
    // the REPL draws anything.
    if (flags.project && flags['project-id']) {
      console.error('Error: --project and --project-id are mutually exclusive. Pick one.');
      process.exit(2);
    }
    if (flags.project !== undefined || flags['project-id'] !== undefined) {
      const { projects } = await loadProjects();
      let resolved = null;
      if (flags['project-id'] !== undefined) {
        const id = flags['project-id'];
        resolved = projects[id] || null;
        if (!resolved) {
          console.error(`Error: no project with id '${id}'.`);
          console.error('Available ids:');
          for (const p of Object.values(projects)) console.error(`  ${p.id}  ${p.name}`);
          process.exit(2);
        }
      } else {
        const name = flags.project;
        const matches = Object.values(projects).filter(p => p.name === name);
        if (matches.length === 0) {
          console.error(`Error: no project named '${name}'.`);
          console.error('Available projects:');
          for (const p of Object.values(projects)) console.error(`  ${p.name}  (id=${p.id})`);
          process.exit(2);
        }
        if (matches.length > 1) {
          console.error(`Error: multiple projects named '${name}'. Use --project-id=<id> instead.`);
          for (const p of matches) console.error(`  ${p.id}`);
          process.exit(2);
        }
        resolved = matches[0];
      }
      // NOTE: we intentionally do NOT call setCurrentProject() here. Writing
      // the shared global `current` pointer would race with a parallel
      // `hk2 --project=<other>` process and could later flip this session
      // onto the other project on reload. Instead we pass the resolved id
      // into interactive(), which pins it per-session.
      console.error(`Selected project: ${resolved.name} (id=${resolved.id})`);
      await launchFrontend(flags, { projectId: resolved.id, resume: flags.resume });
      return;
    }

    // --resume / --resume=<sessionId> without an explicit project: resolve
    // the session under the CURRENT project (global `current` pointer).
    if (flags.resume !== undefined) {
      await launchFrontend(flags, { resume: flags.resume });
      return;
    }

    await launchFrontend(flags, {});
    return;
  }

  await ensureHome();

  const runMode = flags['run-mode'] || 'once';
  if (!VALID_RUN_MODES.has(runMode)) {
    console.error(`Error: invalid --run-mode '${runMode}'. Valid: ${Array.from(VALID_RUN_MODES).join(', ')}`);
    process.exit(1);
  }

  if (runMode === 'serve') {
    const { serve } = await import('./commands/serve.js');
    await serve();
    return;
  }

  const mode = flags.mode;
  if (!mode) {
    console.error('Error: --mode is required (or run with no flags for interactive mode). See --help for usage.');
    process.exit(1);
  }
  if (!VALID_MODES.has(mode)) {
    console.error(`Error: invalid mode '${mode}'. Valid modes: ${Array.from(VALID_MODES).join(', ')}`);
    process.exit(1);
  }

  if (mode === 'project-init') {
    const { registerProject } = await import('../lib/config/home.js');
    if (!flags.source) {
      console.error('Error: --source=<path> is required for --mode=project-init.');
      console.error('Example: hk2 --mode=project-init --name=myapp --source=/path/to/repo --source-root=src');
      process.exit(2);
    }
    try {
      const rec = await registerProject({
        name: flags.name,
        sourcePath: flags.source,
        sourceRoot: flags['source-root'] || '',
        includeGlobs: flags.include ? String(flags.include).split(',') : undefined,
        excludeGlobs: flags.exclude ? String(flags.exclude).split(',') : undefined,
      });
      console.log(`Registered project: ${rec.name}  id=${rec.id}`);
      console.log(`  sourcePath: ${rec.sourcePath}`);
      console.log(`  sourceRoot: ${rec.sourceRoot || '(none)'}`);
      console.log(`Next: hk2 --mode=build-kb  (or enter REPL and run /kb init)`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(2);
    }
    return;
  }

  if (mode === 'build-kb') {
    const { buildKb } = await import('./commands/build_kb.js');
    await buildKb(flags);
    return;
  }
  if (mode === 'update-kb') {
    const { updateKb } = await import('./commands/update_kb.js');
    await updateKb();
    return;
  }
}
