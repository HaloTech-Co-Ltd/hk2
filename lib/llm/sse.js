/**
 * SSE 流parse：从 fetch response body 中逐行parse `event:` / `data:` 帧。
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {(event: {event: string, data: string}) => void} onEvent
 * @param {() => void} [onDone]
 */
export async function consumeSSE(stream, onEvent, onDone) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentEvent = 'message';
  let currentData = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        // SSE 帧以empty行end
        if (line === '' || line === '\r') {
          if (currentData !== '') {
            onEvent({ event: currentEvent, data: currentData });
          }
          currentEvent = 'message';
          currentData = '';
          continue;
        }
        if (line.startsWith(':')) continue;   // comment
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          currentData += (currentData ? '\n' : '') + line.slice(5).replace(/^\s/, '');
        } else if (line.startsWith('data: ')) {
          currentData += (currentData ? '\n' : '') + line.slice(6);
        }
      }
    }
    // flush
    if (currentData !== '') {
      onEvent({ event: currentEvent, data: currentData });
    }
    if (onDone) onDone();
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
}
