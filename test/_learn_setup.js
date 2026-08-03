// Test bootstrap: isolate HK2_HOME BEFORE any module that reads it (notably
// lib/config/home.js, imported transitively by src/slash/kb.js) is loaded.
// ESM evaluates imports in source order, so importing this file FIRST
// guarantees the env var is set before home.js captures it.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk2-learn-home-'));
process.env.HK2_HOME = tmp;

export const HK2_HOME = tmp;
