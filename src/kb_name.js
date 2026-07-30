/**
 * KB name resolution for legacy --mode commands.
 *
 * v1: hardcoded 'default'.
 * v2: if there's a current project with a built KB, use its id; otherwise 'default'.
 *
 * Set HK2_KB_NAME to override (for tests / scripts that want to name a KB explicitly).
 */
import { getCurrentProject, projectKbDir } from '../lib/config/home.js';
import { exists } from '../lib/util/fs_atomic.js';
import path from 'node:path';

export async function resolveKbName() {
  if (process.env.HK2_KB_NAME) return process.env.HK2_KB_NAME;
  const p = await getCurrentProject();
  if (p) {
    const kbDir = projectKbDir(p.id);
    if (await exists(path.join(kbDir, 'meta.json'))) return p.id;
  }
  return 'default';
}
