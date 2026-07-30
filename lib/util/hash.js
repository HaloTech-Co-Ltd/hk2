/**
 * file / stringhash工具。基于 Node 内置 crypto。
 */
import crypto from 'node:crypto';

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function shortHash(text) {
  return sha256(text).slice(0, 8);
}

export function fileIdFromPath(path, line) {
  // symbolId 由 fileId + 起始行决定。这里仅占位，call方传入full fileId。
  return `${path}:${line}`;
}
