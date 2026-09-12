/**
 * /attach — stage multimodal attachments (image / video / audio) for the
 * next user message.
 *
 *   /attach <path-or-url> [<path-or-url> ...]     stage attachment(s)
 *   /attach                                        list staged attachments
 *   /attach clear                                  drop all staged attachments
 *
 * Works with the session's ACTIVE model: when that model was configured
 * with --multimodal=on (e.g. glm-5.3-flash), the staged files are read and
 * Base64-encoded (local files) or passed through (http URLs) at the NEXT
 * user message, and sent as OpenAI-style multimodal content blocks
 * (image_url / video_url / input_audio) alongside the message text — see
 * lib/agent/attachments.js and runTurn's user-message assembly.
 *
 * Staging validates eagerly (file readable, supported media type, size
 * limit) so the user learns about a bad path NOW instead of when the next
 * message is already on its way to the API. The actual Base64 read happens
 * at send time so the staged list stays cheap to hold and the bytes on the
 * wire reflect the file's final content.
 *
 * Attachments ride exactly ONE user message (the next one), then clear —
 * multimodal input is per-message state, not session state.
 */

import {
  mediaClassOf, MAX_ATTACHMENT_BYTES,
} from '../../lib/agent/attachments.js';

const ATTACH_USAGE = 'Usage: /attach <file-or-url> [<file-or-url> ...]   (stage image / video / audio for your NEXT message)';

export async function cmdAttach(args, ctx) {
  const argv = (args || []).map(a => String(a || '').trim()).filter(Boolean);

  // /attach            → list what is staged
  if (argv.length === 0) {
    const staged = ctx.getAttachments?.() || [];
    if (staged.length === 0) {
      ctx.print('No staged attachments. ' + ATTACH_USAGE);
      return;
    }
    ctx.print(`Staged attachments (${staged.length}) — they will be sent with your NEXT message:`);
    staged.forEach((a, i) => {
      ctx.print(`  ${i + 1}. [${a.media}] ${a.source}`);
    });
    ctx.print('(remove with /attach clear, or restage by clearing and re-adding)');
    return;
  }

  // /attach clear      → drop all
  if (argv[0] === 'clear' || argv[0] === '--clear') {
    ctx.setAttachments?.([]);
    ctx.print('Cleared all staged attachments.');
    return;
  }

  // Capability gate: the session's active model must have multimodal on.
  const cfg = ctx.modelCfg;
  if (!cfg?.multimodal) {
    ctx.print('[attach] The current model does not accept multimodal input.');
    if (cfg?.ref) {
      ctx.print(`  Enable it first: /model set ${cfg.ref} --multimodal=on`);
    } else {
      ctx.print('  Configure a multimodal-capable model first (e.g. glm-5.3-flash with --multimodal=on).');
    }
    ctx.print('  Multimodal-capable model types are listed by /model types.');
    return;
  }

  // Stage each reference; validation is eager (existence / media class /
  // size) but the Base64 read itself happens at send time.
  const { stat } = await import('node:fs/promises');
  const staged = [];
  const errors = [];
  for (const ref of argv) {
    const media = mediaClassOf(ref);
    if (!media) {
      errors.push(`${ref}: unsupported media type (image: png jpg jpeg gif webp bmp | video: mp4 mov mkv avi webm flv m4v | audio: wav mp3 m4a aac ogg flac opus)`);
      continue;
    }
    if (/^https?:\/\//i.test(ref)) {
      staged.push({ media, source: ref });
      continue;
    }
    try {
      const st = await stat(ref);
      if (!st.isFile()) {
        errors.push(`${ref}: not a regular file`);
        continue;
      }
      if (st.size > MAX_ATTACHMENT_BYTES) {
        errors.push(`${ref}: file too large (${(st.size / 1048576).toFixed(1)} MB > ${(MAX_ATTACHMENT_BYTES / 1048576).toFixed(0)} MB limit)`);
        continue;
      }
      staged.push({ media, source: ref });
    } catch (err) {
      errors.push(`${ref}: ${err.code === 'ENOENT' ? 'file not found' : (err.message || 'unreadable')}`);
    }
  }

  // Merge with anything already staged (dedup by source).
  const existing = ctx.getAttachments?.() || [];
  const merged = [...existing];
  for (const s of staged) {
    if (!merged.some(x => x.source === s.source)) merged.push(s);
  }
  ctx.setAttachments?.(merged);

  for (const e of errors) ctx.print(`  ✗ ${e}`);
  if (staged.length > 0) {
    ctx.print(`Staged ${staged.length} attachment(s) (${merged.length} total). They will be sent with your NEXT message:`);
    staged.forEach((a) => ctx.print(`  ✓ [${a.media}] ${a.source}`));
    ctx.print('Then just type your message (e.g. “描述这张图片”) and press enter.');
  }
  if (errors.length > 0 && staged.length === 0) {
    ctx.print('Nothing was staged.');
  }
}
