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
import { ensureHome, loadProjects, setCurrentProject } from '../lib/config/home.js';

const VALID_MODES = new Set(['project-init', 'build-kb', 'update-kb']);
const VALID_RUN_MODES = new Set(['once', 'serve']);

const BOOL_FLAGS = new Set(['help', 'h', 'project-list']);

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
  console.log(`hk2 - knowledge-base-driven coding agent

Default: enter the interactive REPL (agent loop with tool use + automatic KB context).

Usage:
  hk2
      Enter interactive REPL (default).

  hk2 --project=<name>
  hk2 --project-id=<id>
      Enter the REPL with a specific project selected. <name> matches
      projects.json's name field; <id> matches the UUID. The chosen project
      becomes the new current project (persisted to projects.json). Only one
      of the two flags may be given. Only meaningful with the default
      interactive mode (no --mode).

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

  hk2 --help
      Print this help.

Interactive REPL commands (full list via /help):
  /model list | add | set | set-default | use | del | show
  /project init | list | set | show | drop
  /kb init | update | status | search | symbol | neighbors | knowledge | transform | drop
  /session info | list | new | resume
  /clear | /compact | /help | /quit

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
  HK2_DEBUG=1           Print error stacks
`);
}

export async function run() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

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
      await setCurrentProject(resolved.id);
      console.error(`Selected project: ${resolved.name} (id=${resolved.id})`);
    }

    const { interactive } = await import('./commands/interactive.js');
    await interactive();
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
