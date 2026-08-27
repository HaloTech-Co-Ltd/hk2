// Test bootstrap: isolate HK2_HOME BEFORE any module that reads it (same
// pattern as _learn_setup.js). Imported first by claude_import.test.js.
//
// MUST be synchronous: a top-level await here would NOT block the
// evaluation of later sibling imports (node:test ESM semantics) —
// lib/config/home.js would freeze MODELS_PATH against the REAL ~/.hk2
// before the env var lands, and the tests would write fixtures into the
// user's actual config. That exact leak shipped once; mkdtempSync closes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk2-claudeimport-'));
process.env.HK2_HOME = tmp;
export const HK2_HOME = tmp;
