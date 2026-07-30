/**
 * 轻量log：minute级 + hour间戳。无依赖。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
let currentLevel = LEVELS.info;

export function setLevel(name) {
  if (name in LEVELS) currentLevel = LEVELS[name];
}

function fmt(level, msg, extra) {
  const ts = new Date().toISOString();
  const base = `[${ts}] ${level.toUpperCase()} ${msg}`;
  return extra === undefined ? base : `${base} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
}

export const log = {
  debug: (msg, extra) => { if (currentLevel <= LEVELS.debug) console.error(fmt('debug', msg, extra)); },
  info:  (msg, extra) => { if (currentLevel <= LEVELS.info)  console.error(fmt('info',  msg, extra)); },
  warn:  (msg, extra) => { if (currentLevel <= LEVELS.warn)  console.error(fmt('warn',  msg, extra)); },
  error: (msg, extra) => { if (currentLevel <= LEVELS.error) console.error(fmt('error', msg, extra)); },
};

export default log;
