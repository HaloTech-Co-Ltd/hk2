// One-shot harness: run the merged /kb knowledge learn (CODE mode, dry-run)
// against a registered project without entering the REPL. Used to validate
// Phase 1 plan parsing at scale (e.g. postgres with ~3500 indexed files).
//
// Usage: node scripts/learn-once.js <project-name> [--dry-run] [--base-dir=X] ...
import * as home from '../lib/config/home.js';

const argv = process.argv.slice(2);
const projectName = argv[0];
const rest = argv.slice(1);
if (!projectName) {
  console.error('usage: node scripts/learn-once.js <project-name> [--dry-run] [...]');
  process.exit(2);
}

const { projects } = await home.loadProjects();
const p = Object.values(projects || {}).find(x => x.name === projectName);
if (!p) {
  console.error(`no project named '${projectName}'. registered: ${Object.values(projects || {}).map(x => x.name).join(', ')}`);
  process.exit(2);
}

// Set the global current pointer (getProjectOrFail falls back to it without a
// session pin) and load the runtime for ctx.rt.
await home.setCurrentProject(p.id);
const { getRuntime } = await import('../lib/retrieval/kb_runtime.js');
const rt = await getRuntime(p.id);

const { LLMClient } = await import('../lib/llm/client.js');
const cfg = await home.resolveDefaultModel();
if (!cfg) {
  console.error('no default model configured (run the REPL /model set-default first)');
  process.exit(2);
}
const llm = new LLMClient(cfg);

const ctx = {
  print: (s) => console.log(String(s)),
  confirm: async () => false,   // never write to holy accidentally
  setPhase: () => {},
  llm,
  streamLLM: async function* (messages, opts = {}) {
    for await (const evt of llm.stream(messages, opts)) yield evt;
  },
  rt,
};

const { cmdKb } = await import('../src/slash/kb.js');
await cmdKb(['knowledge', 'learn', ...rest], ctx);
