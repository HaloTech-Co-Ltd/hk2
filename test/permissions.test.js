/**
 * setting.json filesystem-permission system tests.
 *
 * Uses mkdtemp projects so no real user config is touched. HK2_HOME is
 * pointed at a temp dir and HK2_PROJECT_SOURCE/cwd at a temp project.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hk2-perm-'));
}

async function setupEnv({ homeRules, projectRules } = {}) {
  const home = await tmp();
  const src = await tmp();
  process.env.HK2_HOME = home;
  process.env.HK2_PROJECT_SOURCE = src;
  if (homeRules) {
    await fs.writeFile(path.join(home, 'setting.json'), JSON.stringify({ permissions: homeRules }, null, 2));
  }
  if (projectRules) {
    await fs.writeFile(path.join(src, 'setting.json'), JSON.stringify({ permissions: projectRules }, null, 2));
  }
  return { home, src };
}

async function cleanup({ home, src }) {
  delete process.env.HK2_HOME;
  delete process.env.HK2_PROJECT_SOURCE;
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  await fs.rm(src, { recursive: true, force: true }).catch(() => {});
}

test('default: inside project → allow r/w/x; outside → deny', async () => {
  const env = await setupEnv({});
  try {
    const { checkPermission, loadPermissionRules, getDefaultRoots } = await import('../lib/config/setting.js');
    const { rules } = await loadPermissionRules({});
    const inside = path.join(env.src, 'lib/foo.js');
    assert.equal(checkPermission(rules, inside, 'r').ok, true);
    assert.equal(checkPermission(rules, inside, 'w').ok, true);
    assert.equal(checkPermission(rules, inside, 'x').ok, true);
    const outside = path.join(os.tmpdir(), 'elsewhere-' + Date.now(), 'x.txt');
    assert.equal(checkPermission(rules, outside, 'r').ok, false);
    assert.equal(checkPermission(rules, outside, 'w').ok, false);
    assert.equal(checkPermission(rules, outside, 'x').ok, false);
    assert.ok(getDefaultRoots().length >= 1);
  } finally {
    await cleanup(env);
  }
});

test('allow rule grants only the listed modes (r-only)', async () => {
  const outside = await tmp();
  const env = await setupEnv({
    homeRules: [{ path: outside, allow: 'r' }],
  });
  try {
    const { checkPermission, loadPermissionRules } = await import('../lib/config/setting.js');
    const { rules } = await loadPermissionRules({});
    const f = path.join(outside, 'a.txt');
    assert.equal(checkPermission(rules, f, 'r').ok, true);
    assert.equal(checkPermission(rules, f, 'w').ok, false);
    assert.equal(checkPermission(rules, f, 'x').ok, false);
  } finally {
    await cleanup(env);
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test('recursive allow /** covers nested paths', async () => {
  const outside = await tmp();
  const env = await setupEnv({
    homeRules: [{ path: outside + '/**', allow: 'rw' }],
  });
  try {
    const { checkPermission, loadPermissionRules } = await import('../lib/config/setting.js');
    const { rules } = await loadPermissionRules({});
    assert.equal(checkPermission(rules, path.join(outside, 'sub/deep/c.txt'), 'w').ok, true);
    // the root itself is NOT covered by a /** rule without the trailing
    // segment... actually path/** includes the dir itself per our impl:
    // rule.abs === dir; target must equal or be under. target === dir → match.
    assert.equal(checkPermission(rules, outside, 'w').ok, true);
    // r granted, x not
    assert.equal(checkPermission(rules, path.join(outside, 'sub/deep/c.txt'), 'x').ok, false);
  } finally {
    await cleanup(env);
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test('deny beats allow on equal prefix; longest prefix wins', async () => {
  const outside = await tmp();
  const sub = path.join(outside, 'sub');
  const env = await setupEnv({
    homeRules: [
      { path: outside, allow: 'rw' },
      { path: sub, deny: 'w' },
    ],
  });
  try {
    const { checkPermission, loadPermissionRules } = await import('../lib/config/setting.js');
    const { rules } = await loadPermissionRules({});
    assert.equal(checkPermission(rules, path.join(outside, 'a.txt'), 'w').ok, true);
    assert.equal(checkPermission(rules, path.join(sub, 'b.txt'), 'w').ok, false);
    assert.equal(checkPermission(rules, path.join(sub, 'b.txt'), 'r').ok, true, 'deny w only blocks w');
  } finally {
    await cleanup(env);
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test('project setting.json layer wins over global on same target', async () => {
  const outside = await tmp();
  const env = await setupEnv({
    homeRules: [{ path: outside, allow: 'r' }],
    projectRules: [{ path: outside, allow: 'rw' }],
  });
  try {
    const { checkPermission, loadPermissionRules } = await import('../lib/config/setting.js');
    const { rules } = await loadPermissionRules({});
    assert.equal(checkPermission(rules, path.join(outside, 'x.txt'), 'w').ok, true, 'project layer upgrades to rw');
  } finally {
    await cleanup(env);
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test('deny rule restricts inside-project path too', async () => {
  const env = await setupEnv({
    projectRules: [{ path: 'secrets', deny: 'r' }],
  });
  try {
    const { checkPermission, loadPermissionRules } = await import('../lib/config/setting.js');
    const { rules } = await loadPermissionRules({});
    const secret = path.join(env.src, 'secrets/key.pem');
    assert.equal(checkPermission(rules, secret, 'r').ok, false);
    assert.equal(checkPermission(rules, secret, 'w').ok, true, 'deny r only blocks r');
    // sibling dir unaffected
    assert.equal(checkPermission(rules, path.join(env.src, 'ok/key.pem'), 'r').ok, true);
  } finally {
    await cleanup(env);
  }
});

test('bash command scanning: mutating cmd on unpermitted path → deny; none → allow', async () => {
  const env = await setupEnv({});
  try {
    const { checkCommandPermission, loadPermissionRules } = await import('../lib/config/setting.js');
    const { rules } = await loadPermissionRules({});
    const bad = await checkCommandPermission(rules, `rm -rf /tmp/definitely-not-ours-${Date.now()}/x`);
    assert.equal(bad.ok, false);
    const good = await checkCommandPermission(rules, 'ls -la && npm test');
    assert.equal(good.ok, true);
    // read-only command on outside path still denied
    const catBad = await checkCommandPermission(rules, `cat /etc/passwd`);
    assert.equal(catBad.ok, false, 'cat /etc/passwd denied');
    // url must not be treated as a path
    const urlOk = await checkCommandPermission(rules, `curl -s https://example.com/path | head -1`);
    assert.equal(urlOk.ok, true, 'URL not treated as path');
  } finally {
    await cleanup(env);
  }
});

test('bash scanning does not false-positive on slash-containing patterns (Issue 4)', async () => {
  const env = await setupEnv({});
  try {
    const { checkCommandPermission, loadPermissionRules } = await import('../lib/config/setting.js');
    const { rules } = await loadPermissionRules({});
    // These previously extracted bogus absolute paths like /config, /b, /m/%d
    // and denied the whole command. All must be allowed now.
    const benign = [
      'grep lib/config .',
      `sed 's/a/b/' f`,
      'date +%Y/%m/%d',
      'echo "a/b"',
      'ls src/lib',
      'npm run build --source-map',
    ];
    for (const cmd of benign) {
      const res = checkCommandPermission(rules, cmd);
      assert.equal(res.ok, true, `benign command falsely denied: ${cmd}`);
    }
    // Sanity: real absolute outside paths are still caught.
    const stillCaught = checkCommandPermission(rules, `cat /etc/passwd`);
    assert.equal(stillCaught.ok, false);
    const stillCaught2 = checkCommandPermission(rules, `rm -rf /tmp/evil-${Date.now()}`);
    assert.equal(stillCaught2.ok, false);
  } finally {
    await cleanup(env);
  }
});

test('executed targets require x; deny:x blocks interpreter invocation (Issue 3)', async () => {
  const env = await setupEnv({});
  const script = path.join(env.src, 'script.sh');
  await fs.writeFile(script, '#!/bin/bash\necho hi\n');
  try {
    const { checkCommandPermission, loadPermissionRules } = await import('../lib/config/setting.js');
    // Project rules are read AFTER setupEnv wrote setting.json — none here.
    const { rules } = await loadPermissionRules({});
    // Default: inside project → x allowed
    assert.equal(checkCommandPermission(rules, `bash ${script}`).ok, true);
    assert.equal(checkCommandPermission(rules, `node ${path.join(env.src, 'x.js')}`).ok, true);

    // deny:x on the script → invocation denied, but reading it stays fine
    await fs.writeFile(path.join(env.src, 'setting.json'), JSON.stringify({
      permissions: [{ path: script, deny: 'x' }],
    }));
    const { rules: rules2 } = await loadPermissionRules({});
    const denied = checkCommandPermission(rules2, `bash ${script}`);
    assert.equal(denied.ok, false, 'deny:x must block bash script.sh');
    assert.match(denied.reason, /needs x/);
    assert.equal(checkCommandPermission(rules2, `cat ${script}`).ok, true, 'cat still allowed (r not denied)');
  } finally {
    await cleanup(env);
  }
});

test('direct absolute-path invocation requires x on the binary (Issue 3)', async () => {
  const env = await setupEnv({});
  try {
    const { checkCommandPermission, loadPermissionRules } = await import('../lib/config/setting.js');
    // An outside absolute binary invoked directly: needs x; no allow rule → denied
    const { rules } = await loadPermissionRules({});
    const res = checkCommandPermission(rules, `/opt/definitely-not-ours/tool --flag`);
    assert.equal(res.ok, false, 'direct invocation of outside binary must need x (and be denied without a rule)');
    assert.match(res.reason, /needs x/);
  } finally {
    await cleanup(env);
  }
});

test('invalid permission chars degrade gracefully: rule dropped, load resolves, path stays denied', async () => {
  const outside = await tmp();
  const env = await setupEnv({
    homeRules: [{ path: outside, allow: 'q' }],
  });
  try {
    const { loadPermissionRules, checkPermission } = await import('../lib/config/setting.js');
    const { rules, errors } = await loadPermissionRules({});
    // Load resolves (never rejects) and the bad rule is reported ...
    assert.equal(rules.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /invalid permission char/);
    // ... and the affected path degrades to deny-by-default.
    assert.equal(checkPermission(rules, path.join(outside, 'f'), 'r').ok, false);
    assert.equal(checkPermission(rules, path.join(outside, 'f'), 'w').ok, false);
  } finally {
    await cleanup(env);
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test('a bad rule in one layer does not block rules from the other layer', async () => {
  const outsideGood = await tmp();
  const outsideBad = await tmp();
  const env = await setupEnv({
    homeRules: [{ path: outsideBad, allow: 'q' }, { path: outsideGood, allow: 'r' }],
  });
  try {
    const { loadPermissionRules, checkPermission } = await import('../lib/config/setting.js');
    const { rules, errors } = await loadPermissionRules({});
    // The valid rule from the same (global) layer survives.
    assert.equal(checkPermission(rules, path.join(outsideGood, 'ok.txt'), 'r').ok, true);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /invalid permission char/);
    void outsideBad;
  } finally {
    await cleanup(env);
    await fs.rm(outsideGood, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outsideBad, { recursive: true, force: true }).catch(() => {});
  }
});

test('PermissionService lazy-load + tool-level integration (read/write on outside path)', async () => {
  const env = await setupEnv({});
  const outside = await tmp();
  try {
    const { getPermissionService } = await import('../lib/config/setting.js');
    const svc = getPermissionService();
    const r1 = await svc.check(path.join(outside, 'f.txt'), 'w');
    assert.equal(r1.ok, false);
    // Now grant via a project setting.json and reload
    await fs.writeFile(path.join(env.src, 'setting.json'), JSON.stringify({ permissions: [{ path: outside, allow: 'w' }] }));
    await svc.reload();
    const r2 = await svc.check(path.join(outside, 'f.txt'), 'w');
    assert.equal(r2.ok, true);
    const r3 = await svc.check(path.join(outside, 'f.txt'), 'r');
    assert.equal(r3.ok, false, 'w-only grant must not allow r');
  } finally {
    await cleanup(env);
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test('~ in rule paths expands to the user home (README-documented contract)', async () => {
  const { normalizeRules, checkPermission } = await import('../lib/config/setting.js');
  const errors = [];
  const rules = normalizeRules(
    [{ path: '~/Documents/notes/**', allow: 'r' }, { path: '~', deny: 'w' }],
    { baseDir: '/nonexistent-base', errors });
  assert.equal(errors.length, 0);
  assert.equal(rules[0].abs, path.join(os.homedir(), 'Documents/notes'));
  assert.equal(rules[1].abs, os.homedir());
  // the expanded rule actually governs access under the home dir
  assert.equal(checkPermission(rules, path.join(os.homedir(), 'Documents/notes/a.md'), 'r').ok, true);
  assert.equal(checkPermission(rules, path.join(os.homedir(), 'Documents/notes/a.md'), 'w').ok, false);
  assert.equal(checkPermission(rules, path.join(os.homedir(), 'other.txt'), 'w').ok, false, '~ deny:w blocks home writes');
});

test('redirects glued to the operator (2>/path, >/path, >>/path, &>/path) are scanned', async () => {
  const { checkCommandPermission } = await import('../lib/config/setting.js');
  const evil = path.join(os.tmpdir(), 'hk2-evil-redirect-' + Date.now());
  const forms = [
    `echo x 2>${evil}`,
    `echo x >${evil}`,
    `echo x >>${evil}`,
    `echo x &>${evil}`,
  ];
  for (const cmd of forms) {
    const res = checkCommandPermission([], cmd);
    assert.equal(res.ok, false, `glued redirect must be denied: ${cmd}`);
  }
  // benign redirect forms stay allowed
  const benign = [
    'ls -la > /dev/null',
    'ls -la 2>/dev/null',
    'ls -la 2>&1',
    'ls -la &>/dev/null',
    'echo hi > out.txt',
    'make 2>&1 | tee log.txt',
  ];
  for (const cmd of benign) {
    const res = checkCommandPermission([], cmd);
    assert.equal(res.ok, true, `benign redirect must stay allowed: ${cmd} (${res.reason})`);
  }
});

test('a rule on the filesystem root covers every absolute target', async () => {
  const { normalizeRules, checkPermission } = await import('../lib/config/setting.js');
  const rules = normalizeRules([{ path: '/', allow: 'rw' }], { baseDir: '/nonexistent', errors: [] });
  assert.equal(checkPermission(rules, '/etc/hosts', 'r').ok, true, 'root allow:rw covers /etc/hosts');
  assert.equal(checkPermission(rules, path.join(os.tmpdir(), 'x'), 'w').ok, true);
  assert.equal(checkPermission(rules, path.join(os.tmpdir(), 'x'), 'x').ok, false, 'x not in allow set');
});

test('project switch refreshes the permission singleton (reloadAll contract)', async () => {
  const home = await tmp();
  const projA = await tmp();
  const projB = await tmp();
  const outside = await tmp();
  process.env.HK2_HOME = home;
  process.env.HK2_PROJECT_SOURCE = projA;
  try {
    await fs.writeFile(path.join(projB, 'setting.json'), JSON.stringify({
      permissions: [{ path: outside, allow: 'rw' }],
    }));
    const { getPermissionService, resetPermissionService } = await import('../lib/config/setting.js');
    resetPermissionService();
    const svc = getPermissionService();
    const before = await svc.check(path.join(outside, 'f.txt'), 'w');
    assert.equal(before.ok, false, 'projA has no rules → outside path denied');
    // simulate what reloadAll does after /project switch
    process.env.HK2_PROJECT_SOURCE = projB;
    resetPermissionService();
    const svc2 = getPermissionService();
    const after = await svc2.check(path.join(outside, 'f.txt'), 'w');
    assert.equal(after.ok, true, 'projB rules must apply after switch+reset');
    assert.equal(svc2.projectRoot, projB, 'singleton re-pins the new project root');
  } finally {
    delete process.env.HK2_HOME;
    delete process.env.HK2_PROJECT_SOURCE;
    for (const d of [home, projA, projB, outside]) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  }
});

/* ------------------------------------------------------------------ */
/* Bypass regression suite (P1 recursive descent / P2 relative bash    */
/* operands / P3 symlink escape) — found by the post-feature audit.    */
/* ------------------------------------------------------------------ */

/** Build a temp project with a denied `secrets/` subtree + allowed siblings,
 * wire HK2_* env, reset the permission singleton, and return live tools. */
async function buildBypassEnv() {
  const base = await tmp();
  const proj = path.join(base, 'proj');
  const secrets = path.join(proj, 'secrets');
  await fs.mkdir(secrets, { recursive: true });
  await fs.writeFile(path.join(secrets, 'key.js'), 'const TOPSECRET = 1;\n');
  await fs.writeFile(path.join(proj, 'app.js'), 'const ok = 1;\n');
  await fs.writeFile(path.join(proj, 'setting.json'), JSON.stringify({
    permissions: [{ path: 'secrets', deny: 'rwx' }],
  }));
  process.env.HK2_HOME = path.join(base, 'home');
  process.env.HK2_PROJECT_SOURCE = proj;
  const { resetPermissionService } = await import('../lib/config/setting.js');
  resetPermissionService();
  const { buildTools } = await import('../lib/agent/tools.js');
  const tools = buildTools(null, {});
  const by = (n) => tools.find(t => t.name === n);
  return { base, proj, secrets, by, cleanup: async () => {
    delete process.env.HK2_HOME;
    delete process.env.HK2_PROJECT_SOURCE;
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  } };
}

test('P1: recursive descent honors deny rules (grep/find/ast_grep from project root)', async () => {
  const env = await buildBypassEnv();
  try {
    // grep from the project ROOT must not return denied subtree content
    const grep = await env.by('grep').execute({ pattern: 'TOPSECRET', path: env.proj });
    const leaked = (grep.matches ?? []).some(m => (m.file ?? '').includes('secrets'));
    assert.equal(leaked, false, 'grep from root must not read denied subtree');
    // grep on the allowed sibling still works (pruning must not over-block)
    const grepOk = await env.by('grep').execute({ pattern: 'ok', path: env.proj });
    assert.equal((grepOk.matches ?? []).some(m => (m.file ?? '').includes('app.js')), true);
    // find must not list denied subtree files
    const found = await env.by('find').execute({ pattern: '**/*', path: env.proj });
    assert.equal((found.files ?? []).some(f => f.includes('secrets')), false,
      'find from root must not list denied subtree');
    assert.equal((found.files ?? []).some(f => f.endsWith('app.js')), true);
    // ast_grep must not read denied subtree sources
    const ag = await env.by('ast_grep').execute({ pat: 'const $N = $$$V', path: env.proj });
    assert.equal(JSON.stringify(ag).includes('secrets'), false,
      'ast_grep from root must not read denied subtree');
    // ast_edit from root must not stage denied subtree files
    const ae = await env.by('ast_edit').execute({ ops: [{ pat: 'const $N = $$$V', out: 'const $N = 2' }], paths: [env.proj] });
    assert.equal(JSON.stringify(ae?.files ?? ae).includes('secrets'), false,
      'ast_edit from root must not stage denied subtree');
    if (ae?.proposed) await env.by('resolve').execute({ proposal_id: ae.proposalId, action: 'discard' });
  } finally {
    await env.cleanup();
  }
});

test('P2: bash relative operands and cd bases resolve against deny rules', async () => {
  const env = await buildBypassEnv();
  try {
    const bash = env.by('bash');
    // `cd <proj> && cat secrets/key.js` — relative operand through a cd base
    const r1 = await bash.execute({ command: `cd ${env.proj} && cat secrets/key.js` });
    assert.equal(Boolean(r1.error), true, 'cd+relative cat of denied subtree must be denied');
    assert.match(r1.error, /permission denied/, 'denial must be a permission error, not a shell failure');
    // read-only relative grep through cd base
    const r2 = await bash.execute({ command: `cd ${env.proj} && grep TOPSECRET secrets/key.js` });
    assert.equal(Boolean(r2.error), true, 'cd+relative grep of denied subtree must be denied');
    // benign slash-bearing commands stay allowed (no false positives)
    for (const cmd of [
      'ls -la',
      'npm test',
      'grep lib/config .',
      `echo hello | sed 's/hello/world/'`,
      'date +%Y/%m/%d',
      'cd lib && ls config',
    ]) {
      const r = await bash.execute({ command: cmd });
      assert.equal(Boolean(r.error), false, `benign command must stay allowed: ${cmd}`);
    }
  } finally {
    await env.cleanup();
  }
});

test('P3: in-project symlink to outside file is denied (realpath re-check)', async () => {
  const base = await tmp();
  const proj = path.join(base, 'proj');
  await fs.mkdir(proj, { recursive: true });
  await fs.writeFile(path.join(base, 'outside-secret.txt'), 'OUTSIDE-LEAK\n');
  await fs.writeFile(path.join(proj, 'app.js'), 'const ok = 1;\n');
  await fs.symlink(path.join(base, 'outside-secret.txt'), path.join(proj, 'link.md'));
  process.env.HK2_HOME = path.join(base, 'home');
  process.env.HK2_PROJECT_SOURCE = proj;
  try {
    const { resetPermissionService } = await import('../lib/config/setting.js');
    resetPermissionService();
    const { buildTools } = await import('../lib/agent/tools.js');
    const tools = buildTools(null, {});
    const readT = tools.find(t => t.name === 'read');
    // symlink path is lexically inside the project but resolves outside
    const r1 = await readT.execute({ path: path.join(proj, 'link.md') });
    assert.equal(Boolean(r1.error), true, 'symlink escape must be denied');
    // plain sibling file still readable (realpath pass must not over-block)
    const r2 = await readT.execute({ path: path.join(proj, 'app.js') });
    assert.equal(Boolean(r2.error), false, 'regular in-project read must stay allowed');
  } finally {
    delete process.env.HK2_HOME;
    delete process.env.HK2_PROJECT_SOURCE;
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test('symlinked workspace root does not over-deny (canonical roots fallback)', async () => {
  // macOS /tmp → /private/tmp: an ordinary in-project file's realpath
  // differs from its lexical path. checkReal must still allow it.
  const env = await buildBypassEnv();
  try {
    const readT = env.by('read');
    const r = await readT.execute({ path: path.join(env.proj, 'app.js') });
    assert.equal(Boolean(r.error), false, 'plain file under a possibly-symlinked tmp root must stay readable');
    const writeT = env.by('write');    const w = await writeT.execute({ path: path.join(env.proj, 'new-file.txt'), content: 'x' });
    assert.equal(Boolean(w.error), false, 'write of a NEW file under tmp root must stay allowed');
  } finally {
    await env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* Fix regression suite (P1 KB-content bypass + config-warn polish)    */
/* "The project KB is equivalent to the project's files": every KB    */
/* surface that mirrors file CONTENT honors deny rules.               */
/* ------------------------------------------------------------------ */

/** Minimal rt stub exposing one in-project file + one denied-subtree file. */
async function buildKbEnv() {
  const base = await tmp();
  const proj = path.join(base, 'proj');
  const secrets = path.join(proj, 'secrets');
  await fs.mkdir(secrets, { recursive: true });
  await fs.writeFile(path.join(proj, 'app.js'),
    '/** doc for okFn */\nexport function okFn() { return "PUBLIC-BODY"; }\n');
  await fs.writeFile(path.join(secrets, 'leaker.js'),
    '/** doc for superSecretFn */\nexport function superSecretFn() { return "TOPSECRET-BODY"; }\n');
  await fs.writeFile(path.join(proj, 'setting.json'), JSON.stringify({
    permissions: [{ path: 'secrets', deny: 'rwx' }],
  }));
  process.env.HK2_HOME = path.join(base, 'home');
  process.env.HK2_PROJECT_SOURCE = proj;
  const { resetPermissionService } = await import('../lib/config/setting.js');
  resetPermissionService();

  const mkSym = (name, body, docString) => ({
    id: `s-${name}`, name, kind: 'function', fileId: name === 'okFn' ? 1 : 2,
    lineStart: 2, lineEnd: 2, signature: `function ${name}()`,
    body, docString,
  });
  const appSym = mkSym('okFn', 'export function okFn() { return "PUBLIC-BODY"; }', 'doc for okFn');
  const secretSym = mkSym('superSecretFn', 'export function superSecretFn() { return "TOPSECRET-BODY"; }', 'doc for superSecretFn');
  const files = {
    byId: { 1: { path: 'app.js', hash: 'aaaa1111' }, 2: { path: 'secrets/leaker.js', hash: 'bbbb2222' } },
    byPath: { 'app.js': 1, 'secrets/leaker.js': 2 },
  };
  const rt = {
    files,
    getFileId: (p) => files.byPath[p] ?? null,
    getFilePath: (id) => files.byId[id]?.path ?? null,
    getSymbolsInFile: (id) => (id === 1 ? [appSym] : [secretSym]),
    getSymbolsByName: (n) => (n === 'okFn' ? [appSym] : n === 'superSecretFn' ? [secretSym] : []),
    getSymbolById: (id) => (id === 's-okFn' ? appSym : id === 's-superSecretFn' ? secretSym : null),
    bm: { query: () => [{ symbolId: 's-okFn', score: 2 }, { symbolId: 's-superSecretFn', score: 1 }] },
    callgraph: { byId: {} },
    graph: null,
    findTables: () => [{ doc: 'secrets/leaker.js', section: 's', headers: ['h'], align: [], rows: [['TOPSECRET-CELL']], score: 5 }],
    docIndex: null,
  };
  const { buildTools } = await import('../lib/agent/tools.js');
  const tools = buildTools(rt, {});
  return {
    base, proj, secrets, rt, tools, by: (n) => tools.find(t => t.name === n),
    cleanup: async () => {
      delete process.env.HK2_HOME;
      delete process.env.HK2_PROJECT_SOURCE;
      await fs.rm(base, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test('P1-fix: kb_search suppresses snippet+slice for denied source file', async () => {
  const env = await buildKbEnv();
  try {
    const r = await env.by('kb_search').execute({ query: 'okFn superSecretFn', skip_rewrite: true });
    assert.equal(Boolean(r.error), false);
    const pub = r.results.find(x => x.name === 'okFn');
    const sec = r.results.find(x => x.name === 'superSecretFn');
    assert.ok(pub.snippet && pub.snippet.includes('PUBLIC-BODY'), 'allowed file keeps content snippet');
    assert.ok(sec, 'denied file row still present (metadata navigation)');
    assert.equal(sec.snippet, undefined, 'denied file snippet suppressed');
    assert.equal(sec.slice, undefined, 'denied file slice suppressed');
    assert.ok(r.permissionFiltered && r.permissionFiltered.some(p => p.includes('secrets')),
      'permissionFiltered lists the denied path');
  } finally {
    await env.cleanup();
  }
});

test('P1-fix: kb_symbol / kb_outline blank docString for denied file', async () => {
  const env = await buildKbEnv();
  try {
    const bad = await env.by('kb_symbol').execute({ name: 'superSecretFn' });
    assert.equal(Boolean(bad.error), false);
    assert.equal(bad.symbols[0].docString, undefined, 'kb_symbol docString suppressed for denied file');
    assert.ok(bad.symbols[0].signature, 'signature metadata stays');

    const ok = await env.by('kb_symbol').execute({ name: 'okFn' });
    assert.ok(ok.symbols[0].docString && ok.symbols[0].docString.includes('okFn'), 'allowed file keeps docString');

    const outlineBad = await env.by('kb_outline').execute({ path: 'secrets/leaker.js' });
    assert.equal(Boolean(outlineBad.error), false);
    assert.equal(outlineBad.outline[0].docString, '', 'kb_outline docString blanked for denied file');
  } finally {
    await env.cleanup();
  }
});

test('P1-fix: kb_class blanks docString for denied file (last content outlet)', async () => {
  // The shared buildKbEnv stub has graph: null, which short-circuits kb_class
  // with 'knowledge graph not built' — extend it with a minimal graph holding
  // one allowed-file class and one denied-subtree class.
  const env = await buildKbEnv();
  try {
    const mkNode = (name, filePath, docString) => ({
      id: `g-${name}`, name, qualName: name, kind: 'class',
      filePath, lineStart: 1, lineEnd: 9,
      superClassNames: [], implementsNames: [], docString,
    });
    const okNode = mkNode('OkClass', 'app.js', 'doc for OkClass');
    const secretNode = mkNode('SecretClass', 'secrets/leaker.js', 'TOPSECRET-CLASS-DOC');
    const rt = {
      ...env.rt,
      graph: { nodes: new Map([[okNode.id, okNode], [secretNode.id, secretNode]]) },
      searchNodes: (q, n) => (q === 'OkClass' ? [okNode] : q === 'SecretClass' ? [secretNode] : []).slice(0, n),
      getClassMembers: () => [],
      getImplementations: () => [],
      resolveByQualName: () => null,
      toSymbolId: (id) => id.replace(/^g-/, 's-'),
    };
    const { buildTools } = await import('../lib/agent/tools.js');
    const tools = buildTools(rt, {});
    const kbClass = tools.find(t => t.name === 'kb_class');

    const bad = await kbClass.execute({ name: 'SecretClass' });
    assert.equal(Boolean(bad.error), false);
    assert.equal(bad.docString, '', 'kb_class docString must be blanked for denied file');
    assert.equal(bad.name, 'SecretClass', 'class metadata stays (navigation)');

    const ok = await kbClass.execute({ name: 'OkClass' });
    assert.equal(Boolean(ok.error), false);
    assert.ok(ok.docString && ok.docString.includes('OkClass'), 'allowed file keeps docString');
  } finally {
    await env.cleanup();
  }
});

test('P1-fix: per-turn context builder suppresses snippets/docs/tables of denied files', async () => {
  const env = await buildKbEnv();
  try {
    const { buildRequestGraph, renderRequestGraph } = await import('../lib/agent/graph.js');
    const graph = await buildRequestGraph(env.rt, 'okFn superSecretFn', {});
    const sec = graph.symbols.find(s => s.name === 'superSecretFn');
    const pub = graph.symbols.find(s => s.name === 'okFn');
    assert.equal(sec?.snippet, undefined, 'context snippet suppressed for denied file');
    assert.ok(pub?.snippet && pub.snippet.includes('PUBLIC-BODY'), 'context snippet kept for allowed file');
    assert.equal(graph.docTables.filter(t => String(t.doc).includes('secrets')).length, 0,
      'doc tables from denied files dropped');
    const rendered = renderRequestGraph(graph);
    assert.equal(rendered.includes('TOPSECRET'), false, 'rendered context must not contain denied content');
    assert.ok(rendered.includes('PUBLIC-BODY'), 'allowed content still present');
  } finally {
    await env.cleanup();
  }
});

test('P1-fix: resolve(apply) re-checks via checkReal (symlink swap after staging)', async () => {
  const base = await tmp();
  const proj = path.join(base, 'proj');
  await fs.mkdir(proj, { recursive: true });
  await fs.writeFile(path.join(proj, 'a.js'), 'const x = 1;\n');
  await fs.writeFile(path.join(proj, 'setting.json'), JSON.stringify({ permissions: [] }));
  const outsideVictim = path.join(base, 'victim.txt');
  await fs.writeFile(outsideVictim, 'VICTIM\n');
  process.env.HK2_HOME = path.join(base, 'home');
  process.env.HK2_PROJECT_SOURCE = proj;
  try {
    const { resetPermissionService } = await import('../lib/config/setting.js');
    resetPermissionService();
    const { buildTools } = await import('../lib/agent/tools.js');
    const tools = buildTools(null, {});
    const stage = await tools.find(t => t.name === 'ast_edit')
      .execute({ ops: [{ pat: 'const $N = $$$V', out: 'const $N = 2' }], paths: [proj] });
    assert.equal(stage.proposed, true, 'staging works while file is regular');
    // Swap the staged target for a symlink to an outside file AFTER staging
    await fs.rm(path.join(proj, 'a.js'));
    await fs.symlink(outsideVictim, path.join(proj, 'a.js'));
    const ap = await tools.find(t => t.name === 'resolve')
      .execute({ proposal_id: stage.proposalId, action: 'apply' });
    assert.equal(Boolean(ap.error), true, 'apply through symlink-to-outside must be denied');
    assert.match(ap.error, /permission denied/);
    await tools.find(t => t.name === 'resolve').execute({ proposal_id: stage.proposalId, action: 'discard' });
    const victim = await fs.readFile(outsideVictim, 'utf8');
    assert.equal(victim, 'VICTIM\n');
  } finally {
    delete process.env.HK2_HOME;
    delete process.env.HK2_PROJECT_SOURCE;
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test('config polish: empty permissions array is silent; malformed entries each named', async () => {
  const home = await tmp();
  const src = await tmp();
  process.env.HK2_HOME = home;
  process.env.HK2_PROJECT_SOURCE = src;
  await fs.writeFile(path.join(home, 'setting.json'), JSON.stringify({ permissions: [] }));
  const { loadPermissionRules } = await import('../lib/config/setting.js');
  const empty = await loadPermissionRules({ projectRoot: src });
  assert.equal(empty.errors.length, 0, 'empty permissions array must not warn');
  assert.equal(empty.rules.length, 0);
  await fs.writeFile(path.join(home, 'setting.json'), JSON.stringify({
    permissions: [
      { path: path.join(os.tmpdir(), 'nowhere-' + Date.now()) },
      { path: path.join(os.tmpdir(), 'x-' + Date.now()), allow: 'r', deny: 'w' },
      'not-an-object',
      { path: path.join(os.tmpdir(), 'ok-' + Date.now()), allow: 'r' },
    ],
  }));
  const bad = await loadPermissionRules({ projectRoot: src });
  assert.equal(bad.rules.length, 1, 'only the valid entry becomes a rule');
  assert.equal(bad.errors.length, 3, 'each dropped entry is reported');
  assert.match(bad.errors[0], /missing "allow" or "deny"/);
  assert.match(bad.errors[1], /BOTH "allow" and "deny"/);
  assert.match(bad.errors[2], /not an object/);
  delete process.env.HK2_HOME;
  delete process.env.HK2_PROJECT_SOURCE;
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  await fs.rm(src, { recursive: true, force: true }).catch(() => {});
});

test('no project resolved → stale HK2_PROJECT_SOURCE dropped (reloadAll contract)', async () => {
  const base = await tmp();
  process.env.HK2_HOME = path.join(base, 'home');
  process.env.HK2_PROJECT_SOURCE = path.join(base, 'stale-outer-project');
  try {
    const setting = await import('../lib/config/setting.js');
    setting.resetPermissionService();
    // Simulate the reloadAll else-branch (no project): env deleted + reset
    delete process.env.HK2_PROJECT_SOURCE;
    setting.resetPermissionService();
    const roots = setting.getDefaultRoots();
    assert.equal(roots.includes(path.join(base, 'stale-outer-project')), false,
      'roots must shrink back to cwd after the env is dropped');
    const res = await setting.getPermissionService().check(path.join(base, 'stale-outer-project', 'f.txt'), 'r');
    assert.equal(res.ok, false, 'outside path must be denied once the stale root is dropped');
  } finally {
    delete process.env.HK2_HOME;
    delete process.env.HK2_PROJECT_SOURCE;
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
});
