// Test bootstrap: isolate HK2_HOME BEFORE any module that reads it (notably
// lib/config/home.js, imported transitively by src/slash/kb.js) is loaded.
// ESM evaluates imports in source order, so importing this file FIRST
// guarantees the env var is set before home.js captures it.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk2-learn-home-'));
process.env.HK2_HOME = tmp;

// Neutralize behavior switches that reshape the confirm-prompt sequence these
// tests assert against. With HK2_ENABLE_AUTOUPDATEKB=1 inherited from the
// outer environment, maybeOfferKbUpdate skips its "Run /kb update now?"
// confirm and every subsequent mock answer shifts one slot — the holy-conflict
// decline test consumed [true] as approval and failed spuriously. Same class
// of hazard for HK2_ENABLE_AUTO_LEARN (eden auto-commit) and the learn
// cooldown (skips extraction entirely). These tests drive the prompt flow.
for (const flag of ['HK2_ENABLE_AUTOUPDATEKB', 'HK2_ENABLE_AUTO_LEARN', 'HK2_KB_LEARN_COOLDOWN_MIN', 'HK2_KB_LEARN_VALIDATE']) {
  delete process.env[flag];
}

export const HK2_HOME = tmp;
