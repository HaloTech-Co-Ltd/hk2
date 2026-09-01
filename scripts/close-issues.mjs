#!/usr/bin/env node
/**
 * Post fix comments on issues #2–#7 and close them as completed.
 *
 * Usage:
 *   GITHUB_TOKEN=<token> node scripts/close-issues.mjs          # live
 *   node scripts/close-issues.mjs --dry-run                     # print only
 *
 * The token is read from the environment ONLY at call time — never stored,
 * never echoed, never written to any file (Supreme Code #1: no credentials
 * in code, tests, or config). Requires repo scope (or fine-grained token
 * with issues:write on HaloTech-Co-Ltd/hk2).
 */
const REPO = 'HaloTech-Co-Ltd/hk2';
const dryRun = process.argv.includes('--dry-run');
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!dryRun && !token) {
  console.error('Set GITHUB_TOKEN (or GH_TOKEN) to post. Use --dry-run to preview.');
  process.exit(1);
}

const COMMENTS = {
  2: `Fixed in 41ad7e2 — reinstall now preserves user data.

**Root cause** (confirmed): \`INSTALL_DIR\` defaults to \`~/.hk2\`, the same directory \`lib/config/home.js\` uses as \`HK2_HOME\` for user data. The reinstall branch did \`rm -rf ~/.hk2\` before copying the code tree back in — wiping models.json/projects.json (incl. API keys), kb/ (incl. Holy Space), sessions/, logs/, theme.json with no confirmation or backup.

**Fix**: \`install.sh\` now defines the \`DATA_ITEMS\` contract (models.json, projects.json, theme.json, kb, sessions, logs — mirroring HK2_HOME + THEME_PATH in the code). On reinstall, when any of them exists in the install dir they are moved aside to \`<INSTALL_DIR>.hk2-preserve\`, the code tree is refreshed, and they are moved back on top (user data wins over any same-named shipped item). A stale preserve-dir from an interrupted earlier run is removed first so it can never be silently clobbered. \`--preserve-data=off\` restores the legacy wipe explicitly, and the installed copy no longer ships \`.git\`/\`node_modules\`. README updated.

**Tests** (test/install_preserve_data.test.js, 4 cases): sandboxed-HOME reinstall preserves all six data items; custom \`HK2_INSTALL_DIR\` never touches \`~/.hk2\`; \`--preserve-data=off\` keeps the explicit wipe; no \`.git\`/\`node_modules\` remain.

Note: full directory separation (install artifacts under \`~/.hk2/app\`) was considered and deferred — it changes \`HK2_INSTALL_DIR\` semantics for existing installs; the preserve contract fixes the data-loss path without that migration. The README still recommends a separate \`HK2_INSTALL_DIR\` for clean setups.`,

  3: `Fixed in bb701e7 — error envelope corrected; failures are no longer cached.

**Root cause** (confirmed, two layers):
1. \`executeToolCall\` wrapped every non-throwing tool return in \`ok: true\` — including the dominant \`{ error: <string> }\` failure style (~60 call sites in tools.js), so those failures surfaced to \`onToolCallEnd\` UI, transcript logging, and stuck-detection fingerprints as successes.
2. \`runLoop\` cached tool results by name+args without checking \`ok\`, so a transient failure ("knowledge graph not built", IO hiccup) was pinned for the entire run — the model could never retry it.

**Fix**: a result whose ONLY own field is \`error\` now maps to \`{ ok: false, error }\`. Deliberately conservative: results carrying additional fields (e.g. a partial multi-file \`resolve\` returning \`{ error, applied, files }\`) keep their shape and \`ok: true\` so no payload is lost; the \`throw\` path is unchanged. The cache write is now gated on \`result.ok\` — failures can be retried within the same run. What the LLM sees per tool message is unchanged (both shapes already serialized to an \`{error}\` payload).

**Tests** (test/tool_error_contract.test.js): pure-error mapping; partial-success preservation; throw path; failed call → same-args retry re-executes (mock count 2, second call succeeds); successful calls still hit the cache.

**Priority note**: kept at P1 as reported. One scope correction from the original report: the cache was per-run in-memory only (single runLoop), not persisted across sessions.`,

  4: `Fixed in bb701e7 — replay now reconstructs per-round tool messages.

**Root cause** (confirmed): the flat JSONL transcript had no round boundary, so \`replayTranscript\` coalesced ALL consecutive \`tool_call\` events into one synthesized \`assistant.tool_calls\` message — sequential dependent rounds replayed as if issued in parallel (causality distortion), and the replay never matched the original message sequence for audit.

**Fix** (as suggested in the issue): \`runLoop\` stamps every executed tool call with its loop-round index, \`logToolCall\` persists \`round\`, and \`replayTranscript\` groups by round — each round reconstructs as its own \`assistant.tool_calls\` message followed by that round's \`role:tool\` results, mirroring exactly what the loop pushed per iteration. Fully backward compatible: legacy transcripts without the field keep the documented coalescing behavior; mixed old/new lines group forward with the previous batch. \`resumeSessionInto\` needed no change and inherits the fix.

**Tests** (test/tool_error_contract.test.js): 3 sequential rounds (incl. one true 2-call parallel round) replay as 3 separate assistant messages with preserved order; legacy no-round transcripts coalesce exactly as before; mixed legacy+stamped handling; runLoop stamping verified via callbacks.

**Priority note**: agreed with the downgrade to P2 — this was a documented trade-off, not an accidental defect, and the grouped shape was protocol-valid.`,

  5: `Fixed in 3f2ac39 — maxTokens now reaches every LLM request.

**Root cause** (confirmed, full chain): \`--max-tokens\` was written by the model add/set commands, displayed by list/show, but \`resolveModelRef\` only read \`contextWindow → maxChars\`; both openai adapter paths derived \`max_tokens = clamp(maxChars/4, 256, 32768)\`. The setting had zero effect on any request.

**Fix**: wired end-to-end — \`resolveModelRef\` passes \`maxTokens\`; \`LLMClient\` maps it to \`maxOutputTokens\` (shared \`_buildArgs\`, so stream and complete cannot diverge); the openai adapters send it verbatim as \`max_tokens\` on BOTH the streaming and complete paths; the anthropic adapter scales its thinking/text budget split (40/60) from the explicit total instead of the context-window estimate. Unset keeps the old derivation unchanged. \`/model show\` now prints the EFFECTIVE value ("sent as max_tokens" vs "derived from contextWindow: ~N tokens").

**Tests** (test/llm_maxtokens_complete.test.js, 8 cases, mock fetch): explicit 1234 lands on the wire as \`max_tokens: 1234\` on both paths; unset falls back to \`maxChars/4\`; \`resolveModelRef\` pass-through; plus the #6 assertions.

**Priority note**: upgraded to P1 as the analysis suggested — silent config failure on core generation behavior, and trivially cheap to fix once #6's shared builder existed.

**Upgrade note**: if you had raised \`--max-tokens\` expecting longer outputs, it now actually applies — re-check the value if you set it very high.`,

  6: `Fixed in 3f2ac39 — complete() now forwards signal + headers and validates like stream().

**Root cause** (confirmed, two layers):
1. Client layer: \`LLMClient.complete()\` (openai branch) hand-built its args and dropped \`signal: opts.signal\` and \`headers: this.config.headers\`, skipped the fail-fast baseUrl/apiKey/model checks, and silently routed unknown styles down the openai path instead of throwing.
2. Adapter layer: \`completeOpenAI\` had no \`signal\` parameter at all — even a forwarded signal would have been dropped; it only had its internal timeout controller.

**Fix**: extracted \`_buildArgs()\` used by BOTH \`stream()\` and \`complete()\` (single source of truth — the two paths can no longer drift), which carries signal, headers, maxOutputTokens, and all fail-fast validation. \`completeOpenAI\` now bridges an external abort signal into its fetch via \`addEventListener('abort')\` with streamOpenAI's listener discipline (forward once, detach on settle so retried calls don't accumulate listeners). Affected callers (\`/kb code add --code-gen\`, \`/compact\` summarization) inherit cancel + custom-header support automatically; the anthropic branch already delegated to \`stream()\` and is unaffected.

**Tests** (test/llm_maxtokens_complete.test.js): custom provider headers present in \`init.headers\`; external \`AbortController.abort()\` rejects the in-flight \`complete()\` immediately (not at timeout); missing baseUrl and unknown style both fail fast with ZERO requests sent.`,

  7: `Fixed in 3b8bfe3 — models.json/projects.json writes are now serialized across processes.

**Root cause** (confirmed): all writers did unlocked load → mutate → full-file save. \`writeFileAtomic\` (tmp + rename) only prevents torn READS; two concurrent hk2 processes each renamed their own snapshot over the target and the loser's edit silently vanished — rename's atomicity made last-write-wins invisible (file always valid, content regressed). The EXDEV fallback (\`copyFile\` directly onto the target) could additionally expose a torn file to concurrent readers.

**Fix** (three layers, as recommended in the issue):
1. **Lock** — new \`lib/util/lockfile.js\`: \`withLock(target, fn)\` uses an O_EXCL lockfile at \`<target>.lock\` holding \`{pid, ts}\`; stale locks are detected via a \`process.kill(pid, 0)\` liveness probe (EPERM counts as alive) and age (default 30s), then stolen; same-process callers serialize through per-path promise chains; acquisition retries with 5→40ms backoff up to 10s; filesystems without exclusive-create degrade to unlocked rather than deadlock.
2. **Transactional API** — \`withModels(fn)\` / \`withProjects(fn)\` in home.js run load → fn → save under the lock (the loaded snapshot is ALWAYS what's persisted; fn's return value is passed through for callers that need the touched record). All home.js writers migrated (registerProject, setCurrentProject, updateProject, removeProject, set/clearPhaseModelRef, clearProjectDefaultModelRef), plus all seven RMW sites in the /model command (add, set incl. id-rename project-ref sync, del incl. stale-ref cleanup, set-default, use fallback, add-mcpserver).
3. **EXDEV fallback** — \`writeFileAtomic\` now copies to a sibling tmp file and renames, keeping the fallback atomic for readers.

**Tests** (test/config_lock.test.js, 5 cases): two REAL child processes racing 15 \`registerProject\` calls each — all 30 survive (pre-fix lost ~half); the same for concurrent \`withModels\` disjoint-field mutations; stale-lock takeover (dead pid, no deadlock); same-process serialization; lock file cleanup. Full suite 996 tests, zero new failures.`,
};

async function post(issue, body) {
  if (dryRun) {
    console.log(`\n===== #${issue} (dry run) =====\n${body}\n`);
    return;
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues/${issue}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text);
  if (!res.ok || !parsed.id) throw new Error(`comment #${issue} failed: ${text.slice(0, 300)}`);
  console.log(`commented #${issue}: ${parsed.html_url}`);
}

async function close(issue) {
  if (dryRun) {
    console.log(`close #${issue}: would set state=closed (completed)`);
    return;
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues/${issue}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text);
  if (!res.ok || parsed.state !== 'closed') throw new Error(`close #${issue} failed: ${text.slice(0, 300)}`);
  console.log(`closed #${issue} (completed)`);
}

for (const num of [2, 3, 4, 5, 6, 7]) {
  await post(num, COMMENTS[num]);
  await close(num);
}
console.log('\nAll six issues commented and closed' + (dryRun ? ' (DRY RUN)' : '') + '.');
