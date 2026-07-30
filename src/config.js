/**
 * Config facade. All configuration lives under ~/.hk2 (lib/config/home.js).
 * Re-exported here so legacy call sites (`import { ... } from '../config.js'`)
 * keep working during the transition.
 */
export * from '../lib/config/home.js';
