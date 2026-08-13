/**
 * hk2 version.
 *
 * Single source of truth: package.json. `VERSION` is derived from there so
 * the npm package version, `hk2 --version`, and the REPL banner can never
 * drift apart. Bump the version in package.json (and regenerate
 * package-lock.json) to release.
 *
 * Used by:
 *   - `hk2 --version`
 *   - the interactive REPL welcome banner
 *   - `hk2 --help` footer
 */
import pkg from '../package.json' with { type: 'json' };

export const VERSION = pkg.version;
