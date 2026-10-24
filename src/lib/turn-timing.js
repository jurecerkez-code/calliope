// Maps a completed Reson8 turn onto session time. Provider timestamps are
// relative to the first audio frame; capture and network latency are not included.
export function adaptMessage(msg, audioStartMs) {
  if (!msg || msg.type !== 'turn_end') return null;
  const base = audioStartMs ?? 0;
  const words = (msg.words || []).map(w => ({
    text: w.text,
    startMs: Math.round(base + (w.start_ms ?? 0)),
    endMs: Math.round(base + (w.start_ms ?? 0) + (w.duration_ms ?? 0)),
  }));
  const startMs = msg.start_ms != null ? base + msg.start_ms : (words[0]?.startMs ?? base);
  const endMs = msg.start_ms != null && msg.duration_ms != null
    ? base + msg.start_ms + msg.duration_ms
    : (words[words.length - 1]?.endMs ?? startMs);
  return {
    text: (msg.text || '').trim(),
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    words,
  };
}
